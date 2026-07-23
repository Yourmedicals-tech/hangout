-- 011_auth.sql
-- Sign-up. The last thing between this code and real users.
--
-- Phone OTP, not email+password. One account per human, and ban-evasion costs a
-- SIM rather than thirty seconds at mailinator. For an app whose entire job is
-- getting strangers to meet in person, that trade is worth the friction.
--
-- LOCAL vs SUPABASE:
--   Supabase has auth.users and creates a row on OTP verify. Locally that schema
--   does not exist, so the trigger below is created only when it does. Everything
--   else in this file runs identically in both places — which is the whole point
--   of the app.current_user_id() shim in 001.

-- A new profile is a stub: name and area come from onboarding, one screen later.
-- Deliberately NOT is_adult — that is a checkbox the person ticks, not a default
-- we hand out.
create or replace function app.create_profile(
  p_user_id      uuid,
  p_display_name text,
  p_area_id      text,
  p_is_adult     boolean
) returns void
  language plpgsql security definer
  set search_path = public, app
as $$
declare v_initials text;
begin
  if not p_is_adult then
    raise exception 'must be 18 or over';
  end if;

  v_initials := upper(left(regexp_replace(trim(p_display_name), '\s.*$', ''), 1));

  insert into profiles (id, display_name, initials, area_id, approx_location, is_adult)
  select p_user_id, trim(p_display_name), v_initials, p_area_id, centroid, true
    from areas where id = p_area_id
  on conflict (id) do nothing;

  -- and immediately fuzz the location. The centroid above is a placeholder that
  -- lives for microseconds; set_my_area jitters it before anyone can read it.
  perform set_config('app.user_id', p_user_id::text, true);
  perform app.set_my_area(p_area_id, 10);
end;
$$;

grant execute on function app.create_profile(uuid, text, text, boolean) to app_user;

-- On Supabase only: link profiles to auth.users so deleting the auth row
-- cascades the profile, and vice versa via the Edge Function.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'auth') then
    execute 'alter table profiles
               add constraint profiles_auth_fk
               foreign key (id) references auth.users(id) on delete cascade';
  end if;
end $$;
