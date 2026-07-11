-- 001_extensions.sql
-- Extensions and the auth shim.
--
-- The shim matters: it lets every migration below run UNCHANGED against both a
-- local Postgres (where we set app.user_id ourselves) and Supabase (where the
-- caller's identity arrives in the JWT). Without it we'd be maintaining two
-- dialects of the same security model, which is how leaks happen.

create extension if not exists postgis;
create extension if not exists pgcrypto;   -- gen_random_uuid()

create schema if not exists app;

-- Who is calling?
--   locally:  SET LOCAL app.user_id = '<uuid>'
--   supabase: the sub claim of the JWT (this is what auth.uid() reads)
create or replace function app.current_user_id() returns uuid
  language sql
  stable
as $$
  select coalesce(
    nullif(current_setting('app.user_id', true), '')::uuid,
    nullif(
      (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'),
      ''
    )::uuid
  );
$$;

comment on function app.current_user_id is
  'The calling user. Reads app.user_id locally, or the JWT sub on Supabase. '
  'Returns NULL for an anonymous caller, which every RLS policy treats as "sees nothing".';

-- Miles are the unit the product speaks in; metres are the unit PostGIS speaks in.
-- Convert in exactly one place so we can never disagree with ourselves.
create or replace function app.miles_to_metres(miles numeric) returns double precision
  language sql immutable
as $$ select (miles * 1609.344)::double precision; $$;

-- THE HARD CAP. 25 miles, and there is no way to ask for more.
-- Past this you are not finding a neighbour, you are finding a stranger you will
-- drive an hour to meet once. Enforced here so no client can talk us out of it.
create or replace function app.max_radius_miles() returns int
  language sql immutable
as $$ select 25; $$;
