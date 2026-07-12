-- 009_weekly.sql
-- The standing fixture.
--
-- ============================================================================
-- Almost all real amateur sport is a RECURRING FIXTURE, not an event.
-- "The Friday badminton." "The Sunday cricket." Nobody organises those from
-- scratch each week; they exist, and the only question anybody asks is:
--
--     "Are you in this week?"
--
-- That question is the thing WhatsApp is genuinely bad at. It scrolls away.
-- Half the group never answers. The host counts heads by reading back through
-- forty messages of banter, and still turns up not knowing if they are four or
-- six. Then somebody drops out at 5pm and it all falls over.
--
-- So the app asks, every week, on the person's behalf. And -- crucially -- an
-- unanswered regular is NOT a yes. Treating silence as attendance is exactly
-- how you end up with two people at a booked court, and it is the single most
-- expensive assumption you can make.
-- ============================================================================

-- Which week does a game belong to? One definition, used everywhere, so
-- "this week" can never mean two different things in two different queries.
create or replace function app.week_of(p_ts timestamptz) returns date
  language sql immutable
as $$ select date_trunc('week', p_ts)::date; $$;

-- ============================================================================
-- "Your regulars — are you in this week?"
--
-- A row appears here only when ALL of these are true:
--   * you are a regular of a recurring game
--   * it has not happened yet
--   * you have not said yes (you are not on the roster)
--   * you have not said no (no absence row for this week)
--
-- That last pair is the point: the prompt disappears the moment you answer it,
-- either way. A prompt that lingers after you have answered is a prompt people
-- learn to ignore, and then the whole mechanism is dead.
-- ============================================================================
create or replace view my_weekly_prompts
with (security_invoker = true) as
select
  g.id                as game_id,
  g.sport_id,
  g.title,
  g.starts_at,
  g.spots_needed,
  (select count(*) from game_players gp where gp.game_id = g.id)::int as player_count,
  greatest(g.spots_needed
           - (select count(*) from game_players gp where gp.game_id = g.id), 0)::int as spots_left,
  v.area_id,
  a.name              as area_name,
  round((ST_Distance(v.location, me.approx_location) / 1609.344)::numeric, 1) as distance_miles,
  app.week_of(g.starts_at) as week_of,
  -- how many of the regular crew have already answered, either way
  (select count(*) from game_regulars gr
    where gr.game_id = g.id
      and (exists (select 1 from game_players gp
                    where gp.game_id = g.id and gp.profile_id = gr.profile_id)
        or exists (select 1 from game_absences ga
                    where ga.game_id = g.id and ga.profile_id = gr.profile_id
                      and ga.week_of = app.week_of(g.starts_at))))::int as answered,
  (select count(*) from game_regulars gr where gr.game_id = g.id)::int as regulars
from games g
join game_regulars r on r.game_id = g.id and r.profile_id = app.current_user_id()
join venues v on v.id = g.venue_id
join areas  a on a.id = v.area_id
cross join (select approx_location from profiles where id = app.current_user_id()) me
where g.repeats_weekly
  and not g.cancelled
  and g.starts_at > now()
  -- you have not said yes...
  and not exists (
    select 1 from game_players gp
     where gp.game_id = g.id and gp.profile_id = app.current_user_id())
  -- ...and you have not said no.
  and not exists (
    select 1 from game_absences ga
     where ga.game_id = g.id
       and ga.profile_id = app.current_user_id()
       and ga.week_of = app.week_of(g.starts_at))
order by g.starts_at;

comment on view my_weekly_prompts is
  'Recurring games you are a regular of and have NOT yet answered for this week. '
  'Silence is not a yes: an unanswered regular is a question, never an attendance.';

-- ============================================================================
-- "Can't make it this week."
--
-- Note this does NOT remove you as a regular. You are still in the crew; you
-- are just out this Friday. Conflating "I can't make Friday" with "take me off
-- the list forever" is how apps quietly shed their most loyal users.
--
-- And it locks the game, because saying no opens a spot, and opening a spot is
-- exactly the thing that must not race with somebody joining.
-- ============================================================================
create or replace function app.cant_make_it(p_game_id uuid)
  returns int                                   -- how many people we told
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user uuid := app.current_user_id();
  v_game games%rowtype;
  v_told int := 0;
  v_promoted uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'no such game'; end if;

  insert into game_absences (game_id, profile_id, week_of)
  values (p_game_id, v_user, app.week_of(v_game.starts_at))
  on conflict do nothing;

  -- If you had already said yes, saying no now takes you off the roster and
  -- frees the spot. If you never said yes, there is nothing to free.
  delete from game_players where game_id = p_game_id and profile_id = v_user;

  if not found then
    return 0;                                   -- you were never in; no spot opened
  end if;

  insert into game_messages (game_id, profile_id, body)
  values (p_game_id, null,
          (select display_name from profiles where id = v_user) || ' can''t make it this week');

  -- Same order as leave_game: the waitlist gets first refusal, and only if the
  -- queue is empty do we shout at the neighbourhood.
  select profile_id into v_promoted
    from game_waitlist where game_id = p_game_id
   order by joined_at limit 1;

  if v_promoted is not null then
    insert into game_players (game_id, profile_id) values (p_game_id, v_promoted);
    delete from game_waitlist where game_id = p_game_id and profile_id = v_promoted;
    perform app.enqueue_let_in(p_game_id, v_promoted);
    return 0;
  end if;

  v_told := app.enqueue_spot_open(p_game_id, v_user);
  return v_told;
end;
$$;

-- Become a regular of a game you're in. ("Ask me every week.")
create or replace function app.become_regular(p_game_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare v_user uuid := app.current_user_id();
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from game_players
                  where game_id = p_game_id and profile_id = v_user) then
    raise exception 'you must be in a game before you can be a regular of it';
  end if;
  insert into game_regulars (game_id, profile_id)
  values (p_game_id, v_user) on conflict do nothing;
end;
$$;

-- ============================================================================
-- The weekly ask itself.
--
-- Run this on a cron, a few days before each recurring game. It pushes exactly
-- one question to each regular who has not answered -- and nobody else.
--
-- Idempotent by construction: the moment somebody answers, they drop out of
-- game_regulars-not-yet-answered, so re-running never double-asks.
-- ============================================================================
create or replace function app.enqueue_weekly_prompts(p_within interval default '3 days')
  returns int
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare v_count int;
begin
  insert into notifications (profile_id, game_id, kind, title, body)
  select
    gr.profile_id,
    g.id,
    'weekly_prompt',
    s.emoji || ' ' || g.title || ' — are you in?',
    to_char(g.starts_at, 'Dy HH12:MIam')
      || ' · ' || (select count(*) from game_players gp where gp.game_id = g.id)
      || ' in so far'
  from games g
  join game_regulars gr on gr.game_id = g.id
  join sports s on s.id = g.sport_id
  join profiles p on p.id = gr.profile_id
  where g.repeats_weekly
    and not g.cancelled
    and g.starts_at > now()
    and g.starts_at <= now() + p_within
    and p.notify
    -- has not said yes
    and not exists (select 1 from game_players gp
                     where gp.game_id = g.id and gp.profile_id = gr.profile_id)
    -- has not said no
    and not exists (select 1 from game_absences ga
                     where ga.game_id = g.id and ga.profile_id = gr.profile_id
                       and ga.week_of = app.week_of(g.starts_at))
    -- and we have not already asked them this week
    and not exists (select 1 from notifications n
                     where n.game_id = g.id
                       and n.profile_id = gr.profile_id
                       and n.kind = 'weekly_prompt'
                       and n.created_at > now() - interval '6 days');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant select on my_weekly_prompts to app_user;
grant insert, delete on game_absences to app_user;
grant insert on game_regulars to app_user;
grant execute on function
  app.week_of(timestamptz),
  app.cant_make_it(uuid),
  app.become_regular(uuid),
  app.enqueue_weekly_prompts(interval)
to app_user;

-- ============================================================================
-- A REGULAR IS PART OF THE CREW, even in a week they cannot make.
--
-- Caught by the test: saying "can't make it" removes you from the roster, and
-- the RLS on `games` then refused to show you your OWN standing fixture -- you
-- could not even see the prompt asking whether you were in. Say no to the
-- Friday badminton once and it vanishes from your app forever.
--
-- The disclosure ladder protects against STRANGERS. A regular of a game is
-- nobody's stranger: they have been in that game, at that venue, with those
-- people. Being unavailable this Friday does not make them one.
-- ============================================================================
create or replace function app.is_regular(p_game_id uuid) returns boolean
  language sql stable security definer
  set search_path = public, app
as $$
  select exists (
    select 1 from game_regulars
     where game_id = p_game_id
       and profile_id = app.current_user_id()
  );
$$;

drop policy if exists games_members_only on games;
create policy games_members_only on games
  for select using (
    app.is_member(id)
    or host_id = app.current_user_id()
    or app.is_regular(id)              -- the crew, even in a week they're out
  );

drop policy if exists game_players_members_only on game_players;
create policy game_players_members_only on game_players
  for select using (
    app.is_member(game_id) or app.is_host(game_id) or app.is_regular(game_id));

drop policy if exists game_messages_members_only on game_messages;
create policy game_messages_members_only on game_messages
  for select using (app.is_member(game_id) or app.is_regular(game_id));

grant execute on function app.is_regular(uuid) to app_user;

-- ...and the same for the crew tables themselves. Priya could see the GAME but
-- not the row saying she was a regular OF it, so the prompt view returned
-- nothing and she was silently dropped from her own standing fixture.
drop policy if exists game_regulars_members on game_regulars;
create policy game_regulars_members on game_regulars
  for select using (
    app.is_member(game_id) or app.is_host(game_id) or app.is_regular(game_id));

drop policy if exists game_absences_members on game_absences;
create policy game_absences_members on game_absences
  for select using (
    app.is_member(game_id) or app.is_host(game_id) or app.is_regular(game_id));
