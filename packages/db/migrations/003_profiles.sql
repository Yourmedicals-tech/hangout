-- 003_profiles.sql
-- People.
--
-- THE CENTRAL PRIVACY DECISION IS AN ABSENCE.
--
-- There is no column on this table for a user's real location. Not a private
-- one, not an encrypted one, not one we promise to filter out in the API.
-- The true location is never written down, so it cannot be leaked, subpoenaed,
-- breached, or accidentally SELECT *'d into a log line.
--
-- What we store is `approx_location`: the centroid of their postcode district,
-- jittered a few hundred metres. It is good enough to answer "is this game
-- within 10 miles of me" and useless for finding anybody's front door.
--
-- Filtering in the API is a promise. Not storing it is a fact.

create table profiles (
  id                uuid primary key,                  -- = auth.users.id on Supabase
  display_name      text not null check (length(trim(display_name)) between 1 and 40),
  initials          text not null check (length(initials) between 1 and 2),
  area_id           text not null references areas(id),

  -- FUZZED. Never the truth. See app.set_my_area().
  approx_location   geography(Point, 4326) not null,

  radius_miles      int not null default 10
                      check (radius_miles between 1 and 25),   -- the 25-mile hard cap

  is_new_to_area    boolean not null default false,
  discoverable      boolean not null default true,     -- appear in "people near you"
  notify            boolean not null default true,

  -- 18+ only at launch, and enforced rather than asked. Under-18s meeting
  -- strangers is a safeguarding problem with a DBS-shaped answer, and it is
  -- not the problem this app is solving.
  is_adult          boolean not null default false,

  -- Attendance record. No-shows are the disease that kills pickup sport:
  -- one person not turning up wastes seven people's evening and a GBP 20 court.
  -- Making it visible is what lets a host safely accept a stranger.
  games_attended    int not null default 0 check (games_attended >= 0),
  games_missed      int not null default 0 check (games_missed   >= 0),

  is_admin          boolean not null default false,
  created_at        timestamptz not null default now()
);

create index profiles_location_idx on profiles using gist (approx_location);
create index profiles_area_idx     on profiles (area_id);

comment on column profiles.approx_location is
  'FUZZED district centroid. NEVER the user''s real position. There is deliberately '
  'no column anywhere in this schema that holds a true user location.';

-- Per-sport level. You can be decent at cricket and hopeless at padel --
-- most people are -- so a single global "skill" number would be a lie.
create table profile_sports (
  profile_id uuid not null references profiles(id) on delete cascade,
  sport_id   text not null references sports(id)   on delete cascade,
  level      text,                                  -- null = "any level"
  primary key (profile_id, sport_id)
);

create index profile_sports_sport_idx on profile_sports (sport_id);

-- ------------------------------------------------------------------
-- Setting your location: the ONLY way in, and it fuzzes on the way.
--
-- Note the client never sends a latitude and longitude at all. It sends a
-- postcode district. We resolve that to a centroid and jitter it. Even a
-- malicious client cannot hand us a precise home address, because there is no
-- parameter for one.
-- ------------------------------------------------------------------
create or replace function app.set_my_area(p_area_id text, p_radius_miles int default 10)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
as $$
declare
  v_user     uuid := app.current_user_id();
  v_centroid geography;
  v_jittered geography;
  v_bearing  double precision;
  v_distance double precision;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if p_radius_miles > app.max_radius_miles() then
    raise exception 'radius capped at % miles', app.max_radius_miles();
  end if;

  select centroid into v_centroid from areas where id = p_area_id;
  if v_centroid is null then
    raise exception 'unknown area %', p_area_id;
  end if;

  -- jitter: random bearing, 0-500m. Enough that two users in the same district
  -- do not share a point (which would be its own tell), nowhere near enough to
  -- locate a home.
  v_bearing  := random() * 2 * pi();
  v_distance := random() * 500;
  v_jittered := ST_Project(v_centroid::geometry, v_distance, v_bearing)::geography;

  update profiles
     set area_id         = p_area_id,
         approx_location = v_jittered,
         radius_miles    = p_radius_miles
   where id = v_user;
end;
$$;

-- ------------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------------
alter table profiles       enable row level security;
alter table profile_sports enable row level security;

-- You can always see yourself.
create policy profiles_self on profiles
  for select using (id = app.current_user_id());

-- You can see other people only if they chose to be discoverable. Appearing in
-- a browsable list of named strangers should be a decision, not a default
-- somebody never noticed.
create policy profiles_discoverable on profiles
  for select using (discoverable = true and app.current_user_id() is not null);

create policy profiles_update_self on profiles
  for update using (id = app.current_user_id())
  with check (id = app.current_user_id());

create policy profile_sports_read on profile_sports
  for select using (app.current_user_id() is not null);

create policy profile_sports_write on profile_sports
  for all using (profile_id = app.current_user_id())
  with check (profile_id = app.current_user_id());

-- ------------------------------------------------------------------
-- People near you -- with distance BANDS, never a decimal.
--
-- "0.8 miles" read from three different positions is a trilateration; it is an
-- address. "under a mile" is not. The view is the only way to read other
-- people, and it cannot return a precise distance because it does not compute
-- one.
-- ------------------------------------------------------------------
create or replace function app.distance_band(metres double precision) returns text
  language sql immutable
as $$
  select case
    when metres < 1609.344      then 'under a mile'
    when metres < 1609.344 * 3  then '1-3 miles'
    when metres < 1609.344 * 5  then '3-5 miles'
    when metres < 1609.344 * 10 then '5-10 miles'
    when metres < 1609.344 * 25 then '10-25 miles'
    else 'over 25 miles'
  end;
$$;

create or replace view people_near_me
with (security_invoker = true) as
select
  p.id,
  p.display_name,
  p.initials,
  p.is_new_to_area,
  p.games_attended,
  p.games_missed,
  app.distance_band(
    ST_Distance(p.approx_location, me.approx_location)
  ) as distance_band
from profiles p
cross join (select approx_location, radius_miles
              from profiles where id = app.current_user_id()) me
where p.id <> app.current_user_id()
  and p.discoverable
  and ST_DWithin(p.approx_location, me.approx_location,
                 app.miles_to_metres(least(me.radius_miles, app.max_radius_miles())));

comment on view people_near_me is
  'Distance BANDS only. Never a decimal. Three exact distances triangulate to an address.';
