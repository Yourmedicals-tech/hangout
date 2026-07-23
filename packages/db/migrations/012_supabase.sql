-- 012_supabase.sql
-- Make the local schema work on Supabase unchanged.
--
-- Locally we grant everything to `app_user`. Supabase has its own roles:
-- `authenticated` (signed in) and `anon` (not). Rather than rewrite 24 GRANT
-- statements across 11 files — and keep them in sync forever — we grant the
-- app_user ROLE ITSELF to authenticated. Postgres role inheritance does the rest.
--
-- One line instead of twenty-four, and there is now exactly one place where the
-- permission model lives.

do $$
begin
  -- Supabase-only. Locally these roles do not exist and this is a no-op.
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant app_user to authenticated';
  end if;

  -- Anonymous visitors get the public reference data and nothing else: a
  -- locked sport still shows you the three padel courts near you, because
  -- there are no games and no players to hide.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant usage on schema public, app to anon';
    execute 'grant select on areas, sports, venues, venue_sports, sport_areas to anon';
  end if;
end $$;

-- Supabase's PostgREST reads `request.jwt.claims`; app.current_user_id() in 001
-- already handles both that and the local app.user_id setting, so nothing else
-- needs to change. This is the whole compatibility layer.
