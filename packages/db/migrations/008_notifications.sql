-- 008_notifications.sql
-- The push. This is the product.
--
-- ============================================================================
-- Everything else in this app is scaffolding around one sentence:
--
--     "Someone dropped out, and thirty-eight people found out in ten seconds."
--
-- Which means the thing that must be right is not the transport -- Expo and
-- Apple will deliver the bytes -- it is the FAN-OUT. Who gets told.
--
-- Get it wrong in one direction and the person who WOULD have turned up never
-- hears about it, and the court sits empty, and the app has failed at the only
-- job it has.
--
-- Get it wrong in the other direction and you ping a beginner about a
-- competitive game 22 miles away that they were never going to attend, and they
-- turn notifications off, and now you can never reach them again -- which is the
-- same failure, arriving more slowly.
--
-- Notification permission is a one-way door. You get to be wrong about this
-- roughly twice.
-- ============================================================================

-- Where to send. One row per device; a person may have a phone and a tablet.
create table push_tokens (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  token       text not null unique,          -- ExponentPushToken[...]
  platform    text not null check (platform in ('ios','android','web')),
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index push_tokens_profile_idx on push_tokens (profile_id);

-- ============================================================================
-- THE OUTBOX
--
-- We do NOT call Expo's API from inside a database transaction. Two reasons,
-- and both of them bite in production:
--
--   1. If the HTTP call is slow, the transaction holds its locks while it
--      waits -- including the row lock on `games` that the whole join flow
--      depends on. One slow push and nobody in Leicester can join anything.
--
--   2. If the transaction rolls back AFTER the push has gone out, you have told
--      38 people about a spot that does not exist. Unsendable.
--
-- So the transaction only ever writes a ROW. A worker picks rows up and sends
-- them, and can retry, and can fail, without any of that touching the database's
-- correctness. This is the transactional outbox, and it is worth the extra table.
-- ============================================================================
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  game_id     uuid references games(id) on delete cascade,
  kind        text not null,                 -- 'spot_open' | 'new_game' | 'let_in' | ...
  title       text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,                   -- null = still in the outbox
  failed_at   timestamptz,
  error       text
);

create index notifications_unsent_idx on notifications (created_at)
  where sent_at is null and failed_at is null;
create index notifications_profile_idx on notifications (profile_id, created_at desc);

-- Levels are ordered, not arbitrary strings. Kept in one place so "Improver"
-- can never be accidentally above "Advanced" in one query and below it in another.
create or replace function app.level_rank(p_level text) returns int
  language sql immutable
as $LR$
  select case lower(coalesce(p_level, ''))
    when 'beginner'     then 1
    when 'couch to 5k'  then 1
    when 'improver'     then 2
    when '5k'           then 2
    when 'intermediate' then 3
    when '10k'          then 3
    when 'advanced'     then 4
    when 'half and up'  then 4
    else 0                                  -- unknown / "any" -- never excludes
  end;
$LR$;

-- ============================================================================
-- WHO GETS TOLD
--
-- The single most important query in the codebase. Every clause below is a
-- person we are deliberately NOT waking up, and each one was a decision:
-- ============================================================================
create or replace function app.notify_targets(p_game_id uuid, p_exclude uuid default null)
  returns table (profile_id uuid)
  language sql
  stable
  security definer
  set search_path = public, app
as $$
  with g as (
    select gm.*, v.location as venue_location, v.area_id as venue_area
      from games gm
      join venues v on v.id = gm.venue_id
     where gm.id = p_game_id
  )
  select p.id
    from profiles p
    join g on true
    join profile_sports ps
      on ps.profile_id = p.id
     and ps.sport_id   = g.sport_id          -- they play this sport
   where
     -- ...they want to hear from us at all.
     p.notify

     -- ...they are an adult. 18+ is enforced at the join; do not even tempt a
     -- minor with a push about strangers meeting in a car park.
     and p.is_adult

     -- ...they are not already in it. Telling someone about a spot in a game
     -- they are already playing in is the fastest way to teach them your
     -- notifications are noise.
     and not exists (
       select 1 from game_players gp
        where gp.game_id = p_game_id and gp.profile_id = p.id)

     -- ...they are not the host (they know).
     and p.id <> g.host_id

     -- ...and they are not the person who just LEFT.
     -- Without this, dropping out of the Friday game immediately pings you with
     -- "A spot just opened!" about the spot you personally just vacated. It is
     -- absurd, it is the first thing a user would screenshot, and it teaches
     -- them in one move that our notifications are stupid.
     and (p_exclude is null or p.id <> p_exclude)

     -- ...they have not already said they cannot make it this week.
     and not exists (
       select 1 from game_absences ga
        where ga.game_id = p_game_id and ga.profile_id = p.id
          and ga.week_of = date_trunc('week', g.starts_at)::date)

     -- ...the sport is actually OPEN where they live. Pinging someone in LE3
     -- about padel when padel has not launched in LE3 is an invitation they
     -- cannot accept.
     and app.sport_is_live(g.sport_id, p.area_id)

     -- ...THE VENUE IS INSIDE THE RADIUS THEY CHOSE, capped at 25 miles.
     -- Their radius, not ours: a person who said "5 miles" meant it, and a
     -- 22-mile badminton court is a game they will not attend and a
     -- notification they will resent.
     and ST_DWithin(
           g.venue_location,
           p.approx_location,
           app.miles_to_metres(least(p.radius_miles, app.max_radius_miles())))

     -- ...they are not below the level the host asked for. Pinging a beginner
     -- about an "Intermediate and up" ladder is noise AND a small humiliation.
     -- A null level means "any", and a null on either side passes.
     and (
       g.min_level is null
       or ps.level is null
       or app.level_rank(ps.level) >= app.level_rank(g.min_level)
     )

     -- ...and the game has not been called off, and has not already happened.
     and not g.cancelled
     and g.starts_at > now();
$$;


-- ============================================================================
-- A spot opened. Tell the right people.
--
-- Called from leave_game(). Writes rows; sends nothing. The worker sends.
-- ============================================================================
create or replace function app.enqueue_spot_open(p_game_id uuid, p_exclude uuid default null)
  returns int                                -- how many people were told
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_game   games%rowtype;
  v_sport  sports%rowtype;
  v_venue  venues%rowtype;
  v_left   int;
  v_count  int;
begin
  select * into v_game  from games   where id = p_game_id;
  select * into v_sport from sports  where id = v_game.sport_id;
  select * into v_venue from venues  where id = v_game.venue_id;

  select v_game.spots_needed - count(*) into v_left
    from game_players where game_id = p_game_id;

  if v_left <= 0 then
    return 0;                                -- nothing to shout about
  end if;

  insert into notifications (profile_id, game_id, kind, title, body)
  select
    t.profile_id,
    p_game_id,
    'spot_open',
    v_sport.emoji || ' ' ||
      case when v_left = 1 then 'A spot just opened' else v_left || ' spots just opened' end,
    -- The body says how far and roughly where. It does NOT say the venue name.
    -- A push notification is read on a lock screen, in public, by whoever is
    -- looking over your shoulder. The disclosure ladder does not get a holiday
    -- because the text is short.
    v_game.title || ' · ' || to_char(v_game.starts_at, 'Dy HH12:MIam')
      || ' · ' || round((ST_Distance(v_venue.location, pr.approx_location) / 1609.344)::numeric, 1)
      || ' miles away'
  from app.notify_targets(p_game_id, p_exclude) t
  join profiles pr on pr.id = t.profile_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A game was posted. Same audience rules, different words.
create or replace function app.enqueue_new_game(p_game_id uuid)
  returns int
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_game  games%rowtype;
  v_sport sports%rowtype;
  v_venue venues%rowtype;
  v_count int;
begin
  select * into v_game  from games  where id = p_game_id;
  select * into v_sport from sports where id = v_game.sport_id;
  select * into v_venue from venues where id = v_game.venue_id;

  insert into notifications (profile_id, game_id, kind, title, body)
  select
    t.profile_id, p_game_id, 'new_game',
    v_sport.emoji || ' ' || (select display_name from profiles where id = v_game.host_id)
      || ' needs ' ||
      case when v_game.spots_needed - 1 = 1 then 'a player'
           else (v_game.spots_needed - 1)::text || ' players' end,
    v_game.title || ' · ' || to_char(v_game.starts_at, 'Dy HH12:MIam')
      || ' · ' || round((ST_Distance(v_venue.location, pr.approx_location) / 1609.344)::numeric, 1)
      || ' miles away'
  from app.notify_targets(p_game_id) t
  join profiles pr on pr.id = t.profile_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The host let you in. Now -- and only now -- you may be told where it is.
create or replace function app.enqueue_let_in(p_game_id uuid, p_profile_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_game  games%rowtype;
  v_venue venues%rowtype;
begin
  select * into v_game  from games  where id = p_game_id;
  select * into v_venue from venues where id = v_game.venue_id;

  insert into notifications (profile_id, game_id, kind, title, body)
  values (
    p_profile_id, p_game_id, 'let_in',
    (select display_name from profiles where id = v_game.host_id) || ' let you in',
    -- This person IS now a member, so the venue is theirs to know.
    v_venue.name || coalesce(' · ' || v_game.court, '')
      || ' · ' || to_char(v_game.starts_at, 'Dy HH12:MIam')
  );
end;
$$;

-- ============================================================================
-- Wire the enqueues into the flows that already exist.
-- ============================================================================
create or replace function app.leave_game(p_game_id uuid)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user     uuid := app.current_user_id();
  v_game     games%rowtype;
  v_promoted uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'no such game'; end if;

  delete from game_players where game_id = p_game_id and profile_id = v_user;
  if not found then return null; end if;

  insert into game_messages (game_id, profile_id, body)
  values (p_game_id, null,
          (select display_name from profiles where id = v_user) || ' dropped out');

  -- The waitlist gets first refusal. Nobody has to shout.
  select profile_id into v_promoted
    from game_waitlist
   where game_id = p_game_id
   order by joined_at asc
   limit 1;

  if v_promoted is not null then
    insert into game_players (game_id, profile_id) values (p_game_id, v_promoted);
    delete from game_waitlist where game_id = p_game_id and profile_id = v_promoted;
    insert into game_messages (game_id, profile_id, body)
    values (p_game_id, null,
            (select display_name from profiles where id = v_promoted) || ' came off the waitlist');
    perform app.enqueue_let_in(p_game_id, v_promoted);
    return v_promoted;                       -- filled from the queue; no shout needed
  end if;

  -- Nobody waiting. NOW we shout -- and only now, and never at the person who
  -- just walked out of the door.
  perform app.enqueue_spot_open(p_game_id, v_user);
  return null;
end;
$$;

create or replace function app.accept_ask(p_game_id uuid, p_profile_id uuid)
  returns app.join_outcome
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_game  games%rowtype;
  v_taken int;
begin
  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'no such game'; end if;
  if v_game.host_id <> app.current_user_id() then
    raise exception 'only the host decides who joins';
  end if;

  select count(*) into v_taken from game_players where game_id = p_game_id;
  if v_taken >= v_game.spots_needed then return 'waitlisted'; end if;

  insert into game_players (game_id, profile_id)
  values (p_game_id, p_profile_id) on conflict do nothing;
  delete from game_asks where game_id = p_game_id and profile_id = p_profile_id;

  insert into game_messages (game_id, profile_id, body)
  values (p_game_id, null,
          (select display_name from profiles where id = p_profile_id) || ' was let in');

  perform app.enqueue_let_in(p_game_id, p_profile_id);
  return 'joined';
end;
$$;

-- post_game() shouts once, on creation.
create or replace function app.post_game(
  p_sport_id          text,
  p_venue_id          uuid,
  p_title             text,
  p_starts_at         timestamptz,
  p_spots_needed      int,
  p_cost_pence        int,
  p_court             text default null,
  p_repeats_weekly    boolean default false,
  p_approve_required  boolean default false,
  p_beginners_welcome boolean default true,
  p_min_level         text default null,
  p_split_teams       boolean default false,
  p_note              text default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user uuid := app.current_user_id();
  v_id   uuid;
  v_area text;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where id = v_user and is_adult) then
    raise exception 'must be 18 or over';
  end if;

  select area_id into v_area from profiles where id = v_user;
  if not app.sport_is_live(p_sport_id, v_area) then
    raise exception '% is not open in % yet', p_sport_id, v_area;
  end if;

  insert into games (
    sport_id, host_id, venue_id, court, title, starts_at,
    spots_needed, cost_pence, repeats_weekly, approve_required,
    beginners_welcome, min_level, split_teams, note
  ) values (
    p_sport_id, v_user, p_venue_id, p_court, p_title, p_starts_at,
    p_spots_needed, p_cost_pence, p_repeats_weekly, p_approve_required,
    p_beginners_welcome, p_min_level, p_split_teams, p_note
  ) returning id into v_id;

  insert into game_players (game_id, profile_id) values (v_id, v_user);
  if p_repeats_weekly then
    insert into game_regulars (game_id, profile_id) values (v_id, v_user);
  end if;

  perform app.enqueue_new_game(v_id);
  return v_id;
end;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table push_tokens   enable row level security;
alter table notifications enable row level security;

create policy push_tokens_self on push_tokens
  for all using (profile_id = app.current_user_id())
  with check (profile_id = app.current_user_id());

-- You can read your own notifications. Nobody else's -- a notification says
-- where you were invited to be, which is exactly the thing we protect.
create policy notifications_self on notifications
  for select using (profile_id = app.current_user_id());

-- Grants (these objects did not exist when 007_roles.sql ran).
grant select, insert, update, delete on push_tokens to app_user;
grant select on notifications to app_user;
grant execute on function
  app.notify_targets(uuid, uuid),
  app.level_rank(text),
  app.enqueue_spot_open(uuid, uuid),
  app.enqueue_new_game(uuid),
  app.enqueue_let_in(uuid, uuid)
to app_user;
