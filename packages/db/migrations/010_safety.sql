-- 010_safety.sql
-- Block, report, delete. The three things Apple rejects you for, and the one
-- half of safety we hadn't built.
--
-- Host approval protects the HOST. None of it protected the person walking
-- towards strangers. This does.
--
-- App Store Guideline 1.2 requires: a way to report content, a way to block a
-- user, published contact info, and action within 24 hours. Guideline 5.1.1(v)
-- requires in-app account deletion. Both are submission blockers, not polish.

-- ============================================================================
-- BLOCK
-- One row, one direction. The EFFECT is symmetric: if either of you has blocked
-- the other, neither sees the other anywhere. One-way blocking is useless —
-- it leaves the person you blocked still watching you.
-- ============================================================================
create table blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index blocks_blocked_idx on blocks (blocked_id);

-- The one predicate everything below uses. Symmetric on purpose.
create or replace function app.blocked_with(p_other uuid) returns boolean
  language sql stable security definer
  set search_path = public, app
as $$
  select exists (
    select 1 from blocks
     where (blocker_id = app.current_user_id() and blocked_id = p_other)
        or (blocker_id = p_other and blocked_id = app.current_user_id())
  );
$$;

create or replace function app.block_user(p_other uuid) returns void
  language plpgsql security definer
  set search_path = public, app
as $$
declare v_user uuid := app.current_user_id();
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  insert into blocks (blocker_id, blocked_id) values (v_user, p_other)
  on conflict do nothing;

  -- Blocking someone you share a game with has to actually separate you.
  -- Leaving you both on the roster is a block that does nothing, which is worse
  -- than no block at all because it looks like it worked.
  -- The BLOCKER leaves any game the blocked person hosts; the blocked person is
  -- removed from any game the blocker hosts.
  delete from game_players gp
   using games g
   where gp.game_id = g.id
     and gp.profile_id = v_user
     and g.host_id = p_other;

  delete from game_players gp
   using games g
   where gp.game_id = g.id
     and gp.profile_id = p_other
     and g.host_id = v_user;
end;
$$;

create or replace function app.unblock_user(p_other uuid) returns void
  language sql security definer
  set search_path = public, app
as $$
  delete from blocks
   where blocker_id = app.current_user_id() and blocked_id = p_other;
$$;

-- ============================================================================
-- REPORT
-- ponytail: no moderation queue, no auto-hide, no strikes. Admin reads the
-- table. Add tooling when volume makes reading rows painful — with twelve users
-- in Wigston, a SELECT is the moderation queue.
-- ============================================================================
create table reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references profiles(id) on delete cascade,
  reported_id  uuid references profiles(id) on delete cascade,
  game_id      uuid references games(id) on delete set null,
  reason       text not null,
  detail       text,
  created_at   timestamptz not null default now(),
  handled_at   timestamptz,
  handled_note text
);

create index reports_open_idx on reports (created_at) where handled_at is null;

-- Reporting someone blocks them too. Nobody reports a person and then wants to
-- keep seeing them for the 24 hours it takes us to read it.
create or replace function app.report_user(
  p_reported uuid, p_reason text, p_detail text default null, p_game_id uuid default null
) returns void
  language plpgsql security definer
  set search_path = public, app
as $$
begin
  if app.current_user_id() is null then raise exception 'not authenticated'; end if;
  insert into reports (reporter_id, reported_id, game_id, reason, detail)
  values (app.current_user_id(), p_reported, p_game_id, p_reason, p_detail);
  perform app.block_user(p_reported);
end;
$$;

-- ============================================================================
-- DELETE MY ACCOUNT  (Guideline 5.1.1(v))
-- In-app, immediate, no email-support dance.
-- ============================================================================
create or replace function app.delete_my_account() returns void
  language plpgsql security definer
  set search_path = public, app
as $$
declare v_user uuid := app.current_user_id();
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  -- Games you HOST die with you. Leaving orphaned games nobody can cancel is
  -- worse for the people in them than removing the game.
  delete from games where host_id = v_user;
  -- Everything else cascades from profiles.
  delete from profiles where id = v_user;
  -- On Supabase, deleting auth.users is done by the Edge Function that calls
  -- this, using the service-role key. See BUILD_LOG.md.
end;
$$;

-- ============================================================================
-- Blocks apply EVERYWHERE. A block that only works on one screen is not a block.
-- ============================================================================

-- people near you
create or replace view people_near_me
with (security_invoker = true) as
select
  p.id, p.display_name, p.initials, p.is_new_to_area,
  p.games_attended, p.games_missed,
  app.distance_band(ST_Distance(p.approx_location, me.approx_location)) as distance_band
from profiles p
cross join (select approx_location, radius_miles
              from profiles where id = app.current_user_id()) me
where p.id <> app.current_user_id()
  and p.discoverable
  and not app.blocked_with(p.id)
  and ST_DWithin(p.approx_location, me.approx_location,
                 app.miles_to_metres(least(me.radius_miles, app.max_radius_miles())));

-- games_public gains ONE boolean, APPENDED (create-or-replace can only append).
-- Not the host's identity — just "is there a block between us". The ladder still
-- holds: you learn a game is unavailable, never who is running it.
create or replace view games_public
with (security_invoker = false) as
select
  g.id, g.sport_id, g.title, g.starts_at, g.duration_min, g.cost_pence,
  g.spots_needed, g.repeats_weekly, g.approve_required, g.beginners_welcome,
  g.min_level, g.split_teams, g.note, g.is_booked, g.cancelled, g.cancel_reason,
  v.area_id, a.name as area_name,
  (select count(*) from game_players gp where gp.game_id = g.id)::int as player_count,
  greatest(g.spots_needed
           - (select count(*) from game_players gp where gp.game_id = g.id), 0)::int as spots_left,
  hp.games_attended as host_attended,
  hp.games_missed   as host_missed,
  app.is_member(g.id) as i_am_in,
  exists (select 1 from game_asks ga
           where ga.game_id = g.id and ga.profile_id = app.current_user_id()) as i_have_asked,
  exists (select 1 from game_waitlist gw
           where gw.game_id = g.id and gw.profile_id = app.current_user_id()) as i_am_waiting,
  (g.host_id = app.current_user_id()) as i_am_host,
  v.location as venue_location,
  app.blocked_with(g.host_id) as host_blocked
from games g
join venues v on v.id = g.venue_id
join areas  a on a.id = v.area_id
join profiles hp on hp.id = g.host_id;

-- discovery: a game hosted by someone you've blocked does not exist to you
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
  and not gp.host_blocked                      -- <<
  and app.sport_is_live(gp.sport_id, me.area_id)
  and ST_DWithin(gp.venue_location, me.approx_location,
                 app.miles_to_metres(least(me.radius_miles, app.max_radius_miles())));

-- and the push: never notify someone about a game hosted by a person they blocked
create or replace function app.notify_targets(p_game_id uuid, p_exclude uuid default null)
  returns table (profile_id uuid)
  language sql stable security definer
  set search_path = public, app
as $$
  with g as (
    select gm.*, v.location as venue_location
      from games gm join venues v on v.id = gm.venue_id
     where gm.id = p_game_id
  )
  select p.id
    from profiles p
    join g on true
    join profile_sports ps on ps.profile_id = p.id and ps.sport_id = g.sport_id
   where p.notify
     and p.is_adult
     and not exists (select 1 from game_players gp
                      where gp.game_id = p_game_id and gp.profile_id = p.id)
     and p.id <> g.host_id
     and (p_exclude is null or p.id <> p_exclude)
     -- neither party has blocked the other
     and not exists (
       select 1 from blocks b
        where (b.blocker_id = p.id and b.blocked_id = g.host_id)
           or (b.blocker_id = g.host_id and b.blocked_id = p.id))
     and not exists (select 1 from game_absences ga
                      where ga.game_id = p_game_id and ga.profile_id = p.id
                        and ga.week_of = date_trunc('week', g.starts_at)::date)
     and app.sport_is_live(g.sport_id, p.area_id)
     and ST_DWithin(g.venue_location, p.approx_location,
                    app.miles_to_metres(least(p.radius_miles, app.max_radius_miles())))
     and (g.min_level is null or ps.level is null
          or app.level_rank(ps.level) >= app.level_rank(g.min_level))
     and not g.cancelled
     and g.starts_at > now();
$$;

-- ...and you cannot join a game hosted by someone you've blocked.
create or replace function app.join_game(p_game_id uuid, p_waitlist boolean default true)
  returns app.join_outcome
  language plpgsql security definer
  set search_path = public, app
as $$
declare
  v_user    uuid := app.current_user_id();
  v_game    games%rowtype;
  v_taken   int;
  v_my_area text;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from profiles where id = v_user and is_adult) then
    raise exception 'must be 18 or over';
  end if;

  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'no such game'; end if;
  if v_game.cancelled then return 'cancelled'; end if;

  if app.blocked_with(v_game.host_id) then
    raise exception 'unavailable';   -- deliberately vague: do not confirm a block
  end if;

  select area_id into v_my_area from profiles where id = v_user;
  if not app.sport_is_live(v_game.sport_id, v_my_area) then return 'not_live'; end if;

  if exists (select 1 from game_players
              where game_id = p_game_id and profile_id = v_user) then
    return 'already_in';
  end if;

  select count(*) into v_taken from game_players where game_id = p_game_id;

  if v_taken >= v_game.spots_needed then
    if p_waitlist then
      insert into game_waitlist (game_id, profile_id) values (p_game_id, v_user)
      on conflict do nothing;
    end if;
    return 'waitlisted';
  end if;

  if v_game.approve_required then
    if exists (select 1 from game_asks
                where game_id = p_game_id and profile_id = v_user) then
      return 'already_asked';
    end if;
    insert into game_asks (game_id, profile_id) values (p_game_id, v_user);
    return 'asked';
  end if;

  insert into game_players (game_id, profile_id) values (p_game_id, v_user);
  delete from game_waitlist where game_id = p_game_id and profile_id = v_user;
  delete from game_absences where game_id = p_game_id and profile_id = v_user;

  insert into game_messages (game_id, profile_id, body)
  values (p_game_id, null,
          (select display_name from profiles where id = v_user) || ' is in');
  return 'joined';
end;
$$;

alter table blocks  enable row level security;
alter table reports enable row level security;

create policy blocks_self on blocks
  for all using (blocker_id = app.current_user_id())
  with check (blocker_id = app.current_user_id());

-- You see your own reports. Admins see all of them — that IS the queue.
create policy reports_self_or_admin on reports
  for select using (
    reporter_id = app.current_user_id()
    or exists (select 1 from profiles p
                where p.id = app.current_user_id() and p.is_admin));

grant select on blocks, reports to app_user;
grant execute on function
  app.blocked_with(uuid), app.block_user(uuid), app.unblock_user(uuid),
  app.report_user(uuid, text, text, uuid), app.delete_my_account()
to app_user;
