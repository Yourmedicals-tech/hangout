-- 005_join.sql
-- Joining a game. The single most correctness-critical thing in this product.
--
-- ============================================================================
-- THE RACE
-- ============================================================================
-- Friday, 6:02pm. One spot left. Tom's push notification goes out to 38 people.
-- Two of them read it at the same traffic light and both tap "I'm in".
--
-- Naive code:
--     SELECT count(*) FROM game_players  -- both see 3
--     if count < 4:                      -- both true
--         INSERT                         -- both succeed
--
-- Now five people arrive at a four-person court. Or worse, we quietly delete
-- one of them and they find out when they get there. People do not forgive
-- that, and they tell their friends.
--
-- The fix is one clause. `FOR UPDATE` takes a row lock on the GAME. The second
-- caller blocks. When the first commits, the second wakes up, re-reads the
-- count under READ COMMITTED -- now sees 4 -- and is correctly told the game is
-- full and offered the waitlist instead.
--
-- Not a retry loop. Not optimistic locking. Not application-level mutexes.
-- One line of SQL that Postgres has done correctly for thirty years.
-- ============================================================================

do $$ begin
  create type app.join_outcome as enum (
    'joined',        -- you are in
    'asked',         -- approval game: the host has been asked
    'waitlisted',    -- it was full; you are in the queue
    'already_in',    -- idempotent: tapping twice is not an error
    'already_asked',
    'cancelled',     -- the game was called off
    'not_live'       -- that sport is not open in your area yet
  );
exception when duplicate_object then null; end $$;

create or replace function app.join_game(
  p_game_id  uuid,
  p_waitlist boolean default true      -- fall back to the waitlist if full
) returns app.join_outcome
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user    uuid := app.current_user_id();
  v_game    games%rowtype;
  v_taken   int;
  v_my_area text;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- 18+ only. Enforced, not asked.
  if not exists (select 1 from profiles where id = v_user and is_adult) then
    raise exception 'must be 18 or over';
  end if;

  -- ------------------------------------------------------------------
  -- THE LOCK. Everything after this line is serialised per game.
  -- A concurrent caller for the SAME game waits here. A caller for a
  -- DIFFERENT game is not blocked at all, so this costs us no throughput.
  -- ------------------------------------------------------------------
  select * into v_game
    from games
   where id = p_game_id
   for update;                                       -- <<<< the whole ballgame

  if not found then
    raise exception 'no such game';
  end if;

  if v_game.cancelled then
    return 'cancelled';
  end if;

  -- The sport must actually be open where this person lives.
  select area_id into v_my_area from profiles where id = v_user;
  if not app.sport_is_live(v_game.sport_id, v_my_area) then
    return 'not_live';
  end if;

  -- Tapping "I'm in" twice is a double-tap, not an error.
  if exists (select 1 from game_players
              where game_id = p_game_id and profile_id = v_user) then
    return 'already_in';
  end if;

  -- Count is read AFTER the lock. This is the entire point: any concurrent
  -- joiner has either already committed (and is counted here) or is still
  -- blocked behind us (and will count us).
  select count(*) into v_taken
    from game_players
   where game_id = p_game_id;

  if v_taken >= v_game.spots_needed then
    if p_waitlist then
      insert into game_waitlist (game_id, profile_id)
      values (p_game_id, v_user)
      on conflict do nothing;
      return 'waitlisted';
    end if;
    return 'waitlisted';
  end if;

  -- Approval game: the HOST vets you. Never the admin -- an admin in this loop
  -- is a bottleneck by week two, and every person waiting on a reply is a
  -- person who has already gone back to WhatsApp.
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

-- ============================================================================
-- Leaving -- and the auto-fill that makes the waitlist worth having
-- ============================================================================
create or replace function app.leave_game(p_game_id uuid)
  returns uuid    -- the profile promoted off the waitlist, if any
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user      uuid := app.current_user_id();
  v_game      games%rowtype;
  v_promoted  uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  -- Lock again: a departure opens a spot, and the promotion that follows must
  -- not race with somebody else's join.
  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'no such game'; end if;

  delete from game_players where game_id = p_game_id and profile_id = v_user;
  if not found then
    return null;
  end if;

  insert into game_messages (game_id, profile_id, body)
  values (p_game_id, null,
          (select display_name from profiles where id = v_user) || ' dropped out');

  -- The spot does not sit empty and nobody has to shout: the top of the
  -- waitlist is in, automatically.
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
            (select display_name from profiles where id = v_promoted)
            || ' came off the waitlist');
  end if;

  return v_promoted;
end;
$$;

-- ============================================================================
-- The host lets someone in (approval games only)
-- ============================================================================
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
  if v_taken >= v_game.spots_needed then
    return 'waitlisted';
  end if;

  insert into game_players (game_id, profile_id)
  values (p_game_id, p_profile_id)
  on conflict do nothing;

  delete from game_asks where game_id = p_game_id and profile_id = p_profile_id;

  insert into game_messages (game_id, profile_id, body)
  values (p_game_id, null,
          (select display_name from profiles where id = p_profile_id) || ' was let in');

  return 'joined';
end;
$$;

-- ============================================================================
-- Posting a game. Nothing here is fixed: spots_needed is whatever the host
-- says, and the cost comes from the venue but stays editable, because a free
-- park game still costs a fiver each when you are chipping in for a new ball.
-- ============================================================================
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

  -- the host is in their own game
  insert into game_players (game_id, profile_id) values (v_id, v_user);
  if p_repeats_weekly then
    insert into game_regulars (game_id, profile_id) values (v_id, v_user);
  end if;

  return v_id;
end;
$$;
