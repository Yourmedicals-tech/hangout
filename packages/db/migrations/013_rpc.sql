-- 013_rpc.sql
-- The public surface PostgREST can actually call.
--
-- Every function we wrote lives in the `app` schema. PostgREST (and therefore
-- supabase-js `.rpc()`) only sees `public`. Without these wrappers EVERY
-- mutation in the app — join, post, block, delete your account — fails at
-- runtime with "function not found", and only in production, because the local
-- tests call app.* directly.
--
-- Wrappers rather than exposing the whole `app` schema: this file IS the API
-- surface. If it is not listed here, a client cannot call it. app.notify_targets,
-- app.enqueue_* and the rest stay internal, which is where they belong.

create or replace function public.create_profile(
  p_user_id uuid, p_display_name text, p_area_id text, p_is_adult boolean)
  returns void language sql security invoker as $$
  select app.create_profile(p_user_id, p_display_name, p_area_id, p_is_adult);
$$;

create or replace function public.join_game(p_game_id uuid, p_waitlist boolean default true)
  returns app.join_outcome language sql security invoker as $$
  select app.join_game(p_game_id, p_waitlist);
$$;

create or replace function public.leave_game(p_game_id uuid)
  returns uuid language sql security invoker as $$
  select app.leave_game(p_game_id);
$$;

create or replace function public.accept_ask(p_game_id uuid, p_profile_id uuid)
  returns app.join_outcome language sql security invoker as $$
  select app.accept_ask(p_game_id, p_profile_id);
$$;

create or replace function public.post_game(
  p_sport_id text, p_venue_id uuid, p_title text, p_starts_at timestamptz,
  p_spots_needed int, p_cost_pence int, p_court text default null,
  p_repeats_weekly boolean default false, p_approve_required boolean default false,
  p_beginners_welcome boolean default true, p_min_level text default null,
  p_split_teams boolean default false, p_note text default null)
  returns uuid language sql security invoker as $$
  select app.post_game(p_sport_id, p_venue_id, p_title, p_starts_at,
    p_spots_needed, p_cost_pence, p_court, p_repeats_weekly, p_approve_required,
    p_beginners_welcome, p_min_level, p_split_teams, p_note);
$$;

create or replace function public.want_sport(p_sport_id text)
  returns boolean language sql security invoker as $$
  select app.want_sport(p_sport_id);
$$;

create or replace function public.cant_make_it(p_game_id uuid)
  returns int language sql security invoker as $$
  select app.cant_make_it(p_game_id);
$$;

create or replace function public.become_regular(p_game_id uuid)
  returns void language sql security invoker as $$
  select app.become_regular(p_game_id);
$$;

create or replace function public.block_user(p_other uuid)
  returns void language sql security invoker as $$
  select app.block_user(p_other);
$$;

create or replace function public.unblock_user(p_other uuid)
  returns void language sql security invoker as $$
  select app.unblock_user(p_other);
$$;

create or replace function public.report_user(
  p_reported uuid, p_reason text, p_detail text default null, p_game_id uuid default null)
  returns void language sql security invoker as $$
  select app.report_user(p_reported, p_reason, p_detail, p_game_id);
$$;

create or replace function public.delete_my_account()
  returns void language sql security invoker as $$
  select app.delete_my_account();
$$;

create or replace function public.set_my_area(p_area_id text, p_radius_miles int default 10)
  returns void language sql security invoker as $$
  select app.set_my_area(p_area_id, p_radius_miles);
$$;

-- Grant to app_user, which `authenticated` inherits (see 012).
do $$
declare fn text;
begin
  for fn in
    select format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('create_profile','join_game','leave_game','accept_ask',
                         'post_game','want_sport','cant_make_it','become_regular',
                         'block_user','unblock_user','report_user',
                         'delete_my_account','set_my_area')
  loop
    execute format('grant execute on function public.%s to app_user', fn);
  end loop;
end $$;
