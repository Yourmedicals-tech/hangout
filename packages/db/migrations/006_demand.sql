-- 006_demand.sql
-- Demand capture, density thresholds, and the admin inbox.
--
-- The rule that stops this app dying of its own ambition:
--
--   Adding sports DIVIDES your neighbours across more empty rooms.
--
-- The same 200 signups spread over eight sports is 25 people per sport, which
-- inside a 10-mile radius is nobody. Every sport becomes the zero-results
-- screen and the app feels dead in eight directions at once instead of alive
-- in one. So a sport does not exist in an area until it has the density to
-- work -- and until then, the "I want this" tap is not a dead end, it is a
-- waiting list that tells us exactly which sport to open next and where.

create table sport_requests (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  sport_id    text not null references sports(id)   on delete cascade,
  area_id     text not null references areas(id),
  created_at  timestamptz not null default now(),
  unique (profile_id, sport_id)
);

create index sport_requests_sport_area_idx on sport_requests (sport_id, area_id);

-- Two-way. The tap puts a human request in front of a human, and that human
-- can answer. In the early days the founder IS the growth engine.
create table sport_request_messages (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references sport_requests(id) on delete cascade,
  from_admin  boolean not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index srm_request_idx on sport_request_messages (request_id, created_at);

-- ============================================================================
-- "I want this"
--
-- Counts you toward the threshold, files a request with a human, and -- if you
-- happen to be the person who tips it over -- opens the sport then and there.
--
-- Locking sport_areas matters for the same reason as the join: two people
-- tapping the 20th slot at once must not both believe they were the one who
-- launched it, and the sport must be flipped live exactly once.
-- ============================================================================
create or replace function app.want_sport(p_sport_id text)
  returns boolean          -- true if YOU were the one who tipped it over
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user      uuid := app.current_user_id();
  v_area      text;
  v_threshold int;
  v_count     int;
  v_live      boolean;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  select area_id into v_area from profiles where id = v_user;
  select launch_threshold into v_threshold from sports where id = p_sport_id;
  if v_threshold is null then raise exception 'unknown sport %', p_sport_id; end if;

  -- Idempotent: wanting something twice does not count twice.
  insert into sport_requests (profile_id, sport_id, area_id)
  values (v_user, p_sport_id, v_area)
  on conflict (profile_id, sport_id) do nothing;

  if not found then
    return false;               -- already counted
  end if;

  -- Make sure the row exists, then lock it.
  insert into sport_areas (sport_id, area_id, want_count)
  values (p_sport_id, v_area, 0)
  on conflict do nothing;

  select want_count, is_live into v_count, v_live
    from sport_areas
   where sport_id = p_sport_id and area_id = v_area
   for update;                                        -- serialise the launch

  v_count := v_count + 1;

  update sport_areas
     set want_count = v_count,
         is_live    = (v_live or v_count >= v_threshold),
         went_live_at = case
                          when not v_live and v_count >= v_threshold then now()
                          else went_live_at
                        end
   where sport_id = p_sport_id and area_id = v_area;

  -- so it shows up on their profile as a sport they play
  insert into profile_sports (profile_id, sport_id)
  values (v_user, p_sport_id)
  on conflict do nothing;

  return (not v_live and v_count >= v_threshold);
end;
$$;

-- ============================================================================
-- The admin board: which sport, in which postcode, is closest to working.
--
-- Note it ranks by the BEST SINGLE AREA, not the total. "34 people in
-- Leicester want padel" is a vanity number -- if they are spread across five
-- postcodes, none of them can get a game. The only number that means anything
-- is the biggest pile in one place.
-- ============================================================================
create or replace view admin_demand
with (security_invoker = true) as
select
  s.id                as sport_id,
  s.name              as sport_name,
  s.emoji,
  s.launch_threshold,
  sa.area_id,
  a.name              as area_name,
  sa.want_count,
  sa.is_live,
  greatest(s.launch_threshold - sa.want_count, 0) as still_needed,
  (select count(*) from venue_sports vs
     join venues v on v.id = vs.venue_id
    where vs.sport_id = s.id and v.area_id = sa.area_id) as venues_here
from sport_areas sa
join sports s on s.id = sa.sport_id
join areas  a on a.id = sa.area_id
where exists (select 1 from profiles p
               where p.id = app.current_user_id() and p.is_admin)
order by (sa.want_count::numeric / nullif(s.launch_threshold,0)) desc;

alter table sport_requests         enable row level security;
alter table sport_request_messages enable row level security;

-- You can see your own request. An admin can see all of them.
create policy sport_requests_self_or_admin on sport_requests
  for select using (
    profile_id = app.current_user_id()
    or exists (select 1 from profiles p
                where p.id = app.current_user_id() and p.is_admin)
  );

create policy srm_self_or_admin on sport_request_messages
  for select using (
    exists (
      select 1 from sport_requests r
       where r.id = request_id
         and (r.profile_id = app.current_user_id()
              or exists (select 1 from profiles p
                          where p.id = app.current_user_id() and p.is_admin))
    )
  );
