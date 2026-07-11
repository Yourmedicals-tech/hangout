-- 007_roles.sql
-- The role that RLS actually applies to.
--
-- THIS FILE IS LOAD-BEARING FOR EVERY SECURITY TEST WE WRITE.
--
-- `postgres` is a superuser. Superusers BYPASS row-level security entirely --
-- silently, with no error. So a test suite that connects as `postgres` will
-- watch every policy pass and prove absolutely nothing. It is the security
-- equivalent of testing your lock by walking through the wall.
--
-- `app_user` is a plain role with no BYPASSRLS. It is the local stand-in for
-- Supabase's `authenticated` role. Every test connects as this, and so does
-- every real client.

do $$ begin
  create role app_user nologin;
exception when duplicate_object then null; end $$;

grant usage on schema public, app to app_user;

-- Reference data: readable. A leisure centre is a public building.
grant select on areas, sports, venues, venue_sports, sport_areas to app_user;

-- Person- and game-bearing tables: the grant is only half the story. Every one
-- of these has RLS on top, and the RLS is what actually decides.
grant select on profiles, profile_sports to app_user;
grant select on games, game_players, game_regulars, game_absences,
                game_waitlist, game_asks, game_messages to app_user;
grant select on sport_requests, sport_request_messages to app_user;

grant update on profiles to app_user;
grant insert, delete on profile_sports to app_user;
grant insert on game_messages to app_user;
grant delete on game_players to app_user;
grant insert on games to app_user;
grant update on games to app_user;

-- Views. games_public is SECURITY DEFINER (owned by postgres) and therefore
-- bypasses the RLS on `games` -- which is safe only because it selects no
-- venue name, no court and no player names. See 004_games.sql.
grant select on games_public, games_near_me, game_detail,
                people_near_me, admin_demand to app_user;

-- Mutations go through functions, never raw DML. The function is where the
-- lock lives, and the lock is the whole point.
grant execute on function
  app.join_game(uuid, boolean),
  app.leave_game(uuid),
  app.accept_ask(uuid, uuid),
  app.post_game(text, uuid, text, timestamptz, int, int, text, boolean, boolean, boolean, text, boolean, text),
  app.want_sport(text),
  app.set_my_area(text, int),
  app.current_user_id(),
  app.is_member(uuid),
  app.is_host(uuid),
  app.sport_is_live(text, text),
  app.distance_band(double precision),
  app.miles_to_metres(numeric),
  app.max_radius_miles()
to app_user;

-- Belt and braces: even the table owner should be subject to its own policies,
-- so a careless migration run as the owner cannot quietly read past them.
alter table profiles       force row level security;
alter table games          force row level security;
alter table game_players   force row level security;
alter table game_messages  force row level security;
alter table game_waitlist  force row level security;
alter table game_asks      force row level security;
