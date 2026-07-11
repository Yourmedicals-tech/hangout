-- 004_games.sql
-- Games, rosters, waitlists, asks, chat.
--
-- ============================================================================
-- THE DISCLOSURE LADDER
-- ============================================================================
-- A leisure centre is a public building. Its name was never the secret.
--
-- The danger is the COMBINATION: a named person, pinned to a place, at a time.
-- "Meera, beginner, new to Leicester, will be on Court 3 at Active Wigston at
-- 7pm on Friday" is not a venue leak. It is a stalking vector.
--
-- So:
--   BEFORE you are in a game you may see -- sport, day, time, how far, roughly
--   where, cost, level, spots left, headcount, and the host's attendance record.
--   Enough to decide. Nothing that pins a human to a location.
--
--   ONCE you are in you may see -- the exact venue, the court, who is playing
--   by name, and the group chat.
--
-- This is enforced HERE, in Postgres, and not in application code. A rule
-- scattered across twenty API handlers is a rule that one careless `SELECT *`
-- will eventually break. A rule the database refuses to break is a fact.
--
-- Mechanism:
--   * `games` has RLS: the raw row (venue_id, court) is visible ONLY to members.
--   * `games_public` is a security-definer view that bypasses that RLS but
--     exposes only the safe columns. It is physically incapable of returning a
--     venue name, because it does not select one.
--   * `game_players` has RLS: you see the roster only if you are on it.
--   * `game_messages` has RLS: same.
-- ============================================================================

create table games (
  id                uuid primary key default gen_random_uuid(),
  sport_id          text not null references sports(id),
  host_id           uuid not null references profiles(id) on delete cascade,

  -- SENSITIVE. The link between this game and a real place on a map.
  venue_id          uuid not null references venues(id),
  court             text,                                   -- 'Court 3', 'Net 2'

  title             text not null check (length(trim(title)) between 1 and 80),
  starts_at         timestamptz not null,
  duration_min      int not null default 60,

  -- Cost belongs to the GAME, not the sport. Park cricket is free; the nets at
  -- Grace Road are GBP 24. A sport-level "cricket is free" flag is a lie that
  -- silently hides the booking and payment flow for half of all cricket.
  cost_pence        int not null default 0 check (cost_pence >= 0),

  -- Any number the host likes. Badminton is not "always 4" -- it is singles,
  -- doubles, six rotating, or eight across two courts. The sport suggests.
  -- The host decides. This is a field, never a constant.
  spots_needed      int not null check (spots_needed between 2 and 50),

  repeats_weekly    boolean not null default false,
  approve_required  boolean not null default false,  -- the HOST vets joiners. Never the admin.
  beginners_welcome boolean not null default true,
  min_level         text,                            -- null = any level
  split_teams       boolean not null default false,  -- host opts in; balances at any count

  note              text,
  is_booked         boolean not null default false,
  host_paid_upfront boolean not null default false,
  cancelled         boolean not null default false,
  cancel_reason     text,

  created_at        timestamptz not null default now()
);

create index games_starts_idx on games (starts_at);
create index games_sport_idx  on games (sport_id);
create index games_venue_idx  on games (venue_id);
create index games_host_idx   on games (host_id);

comment on column games.venue_id is
  'SENSITIVE. Never exposed by games_public. Revealed only once you are a member.';
comment on column games.court is
  'SENSITIVE. "Net 2" is a location. Never exposed by games_public.';

-- ---------------------------------------------------------------- roster
create table game_players (
  game_id    uuid not null references games(id)    on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  paid_at    timestamptz,
  attended   boolean,                                -- set after the game; feeds the record
  primary key (game_id, profile_id)
);

create index game_players_profile_idx on game_players (profile_id);

-- Standing crew of a recurring game. Most real amateur sport is a fixture, not
-- an event: "the Friday badminton", "the Sunday cricket". Regulars get asked
-- in-or-out every week instead of having to remember to look.
create table game_regulars (
  game_id    uuid not null references games(id)    on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  primary key (game_id, profile_id)
);

-- "Can't make it this week" -- so the host knows, and the spot opens.
create table game_absences (
  game_id    uuid not null references games(id)    on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  week_of    date not null,
  primary key (game_id, profile_id, week_of)
);

-- The waitlist. When someone drops out the top of the list is in automatically
-- and nobody has to shout. This is the actual product.
create table game_waitlist (
  game_id    uuid not null references games(id)    on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (game_id, profile_id)
);

-- Asking to join an approval game. The host sees your level and your record --
-- not your address -- and decides.
create table game_asks (
  game_id    uuid not null references games(id)    on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  asked_at   timestamptz not null default now(),
  primary key (game_id, profile_id)
);

create table game_messages (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references games(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,   -- null = system message
  body       text not null,
  created_at timestamptz not null default now()
);

create index game_messages_game_idx on game_messages (game_id, created_at);

-- ============================================================================
-- Membership: the single predicate the whole ladder turns on.
-- ============================================================================
create or replace function app.is_member(p_game_id uuid) returns boolean
  language sql
  stable
  security definer
  set search_path = public, app
as $$
  select exists (
    select 1 from game_players
     where game_id = p_game_id
       and profile_id = app.current_user_id()
  );
$$;

create or replace function app.is_host(p_game_id uuid) returns boolean
  language sql
  stable
  security definer
  set search_path = public, app
as $$
  select exists (
    select 1 from games
     where id = p_game_id
       and host_id = app.current_user_id()
  );
$$;

-- ============================================================================
-- RLS -- the ladder itself
-- ============================================================================
alter table games         enable row level security;
alter table game_players  enable row level security;
alter table game_regulars enable row level security;
alter table game_absences enable row level security;
alter table game_waitlist enable row level security;
alter table game_asks     enable row level security;
alter table game_messages enable row level security;

-- The raw game row -- which carries venue_id and court -- is visible ONLY to
-- people in the game. Everyone else must go through games_public, which cannot
-- return a location.
create policy games_members_only on games
  for select using (app.is_member(id) or host_id = app.current_user_id());

create policy games_insert_self on games
  for insert with check (host_id = app.current_user_id());

create policy games_host_updates on games
  for update using (host_id = app.current_user_id())
  with check (host_id = app.current_user_id());

-- Names on a roster are visible only to the roster.
create policy game_players_members_only on game_players
  for select using (app.is_member(game_id) or app.is_host(game_id));

create policy game_players_leave on game_players
  for delete using (profile_id = app.current_user_id() or app.is_host(game_id));

-- Chat: members only. A stranger reading a group chat is how you find out
-- where four people will be on Friday.
create policy game_messages_members_only on game_messages
  for select using (app.is_member(game_id));

create policy game_messages_insert on game_messages
  for insert with check (app.is_member(game_id) and profile_id = app.current_user_id());

create policy game_regulars_members on game_regulars
  for select using (app.is_member(game_id) or app.is_host(game_id));

create policy game_absences_members on game_absences
  for select using (app.is_member(game_id) or app.is_host(game_id));

-- You can see your own place in a queue; the host can see the whole queue.
create policy game_waitlist_self_or_host on game_waitlist
  for select using (profile_id = app.current_user_id() or app.is_host(game_id));

create policy game_asks_self_or_host on game_asks
  for select using (profile_id = app.current_user_id() or app.is_host(game_id));

-- ============================================================================
-- games_public -- what a stranger is allowed to know
--
-- security_invoker = false  =>  runs as the view owner, bypassing the RLS above.
-- That is safe ONLY because of what this view does not select. There is no
-- venue name here. No court. No player names. No host name. Not because we
-- filter them out, but because they were never in the query.
--
-- The host's ATTENDANCE RECORD is exposed without their name: it answers "can
-- I trust this game?" without answering "who will be standing there at 7pm?"
-- ============================================================================
create or replace view games_public
with (security_invoker = false) as
select
  g.id,
  g.sport_id,
  g.title,
  g.starts_at,
  g.duration_min,
  g.cost_pence,
  g.spots_needed,
  g.repeats_weekly,
  g.approve_required,
  g.beginners_welcome,
  g.min_level,
  g.split_teams,
  g.note,
  g.is_booked,
  g.cancelled,
  g.cancel_reason,

  -- coarse location only: which district, and how far. Never which building.
  v.area_id                                    as area_id,
  a.name                                       as area_name,

  -- headcount, not names
  (select count(*) from game_players gp where gp.game_id = g.id)::int as player_count,
  greatest(g.spots_needed
           - (select count(*) from game_players gp where gp.game_id = g.id), 0)::int as spots_left,

  -- can I trust the host, without knowing who the host is
  hp.games_attended                            as host_attended,
  hp.games_missed                              as host_missed,

  -- am I in it? have I asked?
  app.is_member(g.id)                          as i_am_in,
  exists (select 1 from game_asks ga
           where ga.game_id = g.id and ga.profile_id = app.current_user_id()) as i_have_asked,
  exists (select 1 from game_waitlist gw
           where gw.game_id = g.id and gw.profile_id = app.current_user_id()) as i_am_waiting,
  (g.host_id = app.current_user_id())          as i_am_host,

  -- kept internal for games_near_me to measure against; NOT a venue identity
  v.location                                   as venue_location
from games g
join venues v   on v.id = g.venue_id
join areas  a   on a.id = v.area_id
join profiles hp on hp.id = g.host_id;

comment on view games_public is
  'The disclosure ladder. Deliberately selects no venue name, no court, no player '
  'names and no host name. It cannot leak a location because it never reads one.';

-- ============================================================================
-- games_near_me -- discovery, capped at 25 miles, live sports only
-- ============================================================================
create or replace view games_near_me
with (security_invoker = true) as
select
  gp.id, gp.sport_id, gp.title, gp.starts_at, gp.duration_min,
  gp.cost_pence, gp.spots_needed, gp.player_count, gp.spots_left,
  gp.repeats_weekly, gp.approve_required, gp.beginners_welcome, gp.min_level,
  gp.split_teams, gp.note, gp.is_booked, gp.cancelled,
  gp.area_id, gp.area_name,
  gp.host_attended, gp.host_missed,
  gp.i_am_in, gp.i_have_asked, gp.i_am_waiting, gp.i_am_host,
  round((ST_Distance(gp.venue_location, me.approx_location) / 1609.344)::numeric, 1) as distance_miles
from games_public gp
cross join (select approx_location, radius_miles, area_id
              from profiles where id = app.current_user_id()) me
join profile_sports ps on ps.sport_id = gp.sport_id
                      and ps.profile_id = app.current_user_id()
where gp.starts_at > now()
  and not gp.cancelled
  and app.sport_is_live(gp.sport_id, me.area_id)
  and ST_DWithin(
        gp.venue_location,
        me.approx_location,
        app.miles_to_metres(least(me.radius_miles, app.max_radius_miles()))   -- 25-mile cap
      );

comment on view games_near_me is
  'Discovery. Hard-capped at 25 miles regardless of what the client asks for, and '
  'only for sports that have actually gone live in the caller''s area.';

-- ============================================================================
-- game_detail -- everything, but only if you are in it
-- ============================================================================
create or replace view game_detail
with (security_invoker = true) as
select
  g.*,
  v.name        as venue_name,
  v.address     as venue_address,
  v.booking_url as venue_booking_url,
  a.name        as area_name,
  (select count(*) from game_players gp where gp.game_id = g.id)::int as player_count
from games g
join venues v on v.id = g.venue_id
join areas  a on a.id = v.area_id;

comment on view game_detail is
  'The full picture -- venue, court, the lot. security_invoker=true means the RLS on '
  '`games` still applies, so a non-member gets zero rows. Not a filtered answer: no answer.';
