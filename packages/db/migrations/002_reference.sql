-- 002_reference.sql
-- Reference data: areas, sports, venues.
--
-- These three tables are PUBLIC on purpose. A leisure centre is a public
-- building; a sport is a fact; a postcode district is on every road sign.
-- Nothing here identifies a person, so nothing here needs protecting.
-- What needs protecting is the LINK between a person, a place, and a time --
-- and that lives in 004_games.sql.

-- ---------------------------------------------------------------- areas
-- Postcode districts. Also the unit at which a sport goes live: padel is
-- 12/20 in LE18 but 4/20 in LE3, and a sport that is "big in Leicester" but
-- thin in every actual postcode is a sport nobody can get a game of.
create table areas (
  id          text primary key,                    -- 'LE18'
  name        text not null,                       -- 'Wigston'
  centroid    geography(Point, 4326) not null,     -- district centre, not anyone's house
  created_at  timestamptz not null default now()
);

create index areas_centroid_idx on areas using gist (centroid);

-- ---------------------------------------------------------------- sports
-- A sport is a CONFIG ROW, not code. Adding pickleball is an INSERT.
--
-- Note what is NOT here: no fixed player count. `typical_players` is a
-- suggestion and `presets` are shortcuts. Badminton is doubles more often than
-- not -- but it is also singles, six rotating, or eight across two courts.
-- The sport suggests. The host decides. Nothing is locked.
create table sports (
  id                text primary key,              -- 'badminton'
  name              text not null,
  emoji             text not null,
  typical_players   int  not null check (typical_players between 2 and 50),
  presets           jsonb not null default '[]',   -- [{"label":"Doubles","n":4}, ...]
  has_teams         boolean not null default false,-- CAN be split into sides; host opts in
  has_levels        boolean not null default false,-- does a mismatched player ruin it?
  level_names       text[] not null default '{}',
  kit               text[] not null default '{}',
  duration_min      int  not null default 60,
  is_outdoor        boolean not null default false,
  weather_dependent boolean not null default false,
  season            text not null default 'year-round',
  guides            jsonb not null default '[]',   -- [{"title":..,"by":..,"len":..}]
  launch_threshold  int  not null default 20,      -- people needed in ONE area
  globally_live     boolean not null default false,-- launched everywhere (badminton, cricket)
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- venues
-- Venues carry EXACT coordinates. They are public buildings with reception
-- desks and car parks -- there is nothing to hide, and the whole "games near
-- me" query depends on knowing precisely where they are.
--
-- Contrast with profiles (003), which never store a true location at all.
create table venues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text not null,
  area_id     text not null references areas(id),
  location    geography(Point, 4326) not null,     -- EXACT. Public building.
  price_pence int  not null default 0 check (price_pence >= 0),
  price_unit  text not null default 'hour',
  booking_url text,
  created_at  timestamptz not null default now()
);

create index venues_location_idx on venues using gist (location);
create index venues_area_idx on venues (area_id);

create table venue_sports (
  venue_id uuid not null references venues(id) on delete cascade,
  sport_id text not null references sports(id) on delete cascade,
  primary key (venue_id, sport_id)
);

create index venue_sports_sport_idx on venue_sports (sport_id);

-- ------------------------------------------------- density thresholds
-- The rule that stops the app dying of its own ambition: adding sports DIVIDES
-- your neighbours across more empty rooms unless each one has the density to
-- work. A sport is not live "in Leicester". It is live in LE18, or it is not
-- live at all.
create table sport_areas (
  sport_id    text not null references sports(id) on delete cascade,
  area_id     text not null references areas(id) on delete cascade,
  want_count  int  not null default 0 check (want_count >= 0),
  is_live     boolean not null default false,
  went_live_at timestamptz,
  primary key (sport_id, area_id)
);

-- A sport is playable here if it launched globally, or if this area crossed
-- its threshold. One function, so the rule can never be applied inconsistently.
create or replace function app.sport_is_live(p_sport_id text, p_area_id text)
  returns boolean
  language sql stable
as $$
  select coalesce(
    (select true from sports where id = p_sport_id and globally_live),
    (select is_live from sport_areas where sport_id = p_sport_id and area_id = p_area_id),
    false
  );
$$;

-- Reference data is readable by everyone, including anonymous visitors.
-- This is what lets a locked sport still show you the three padel courts near
-- you -- there are no games and no players to hide, because none exist.
alter table areas        enable row level security;
alter table sports       enable row level security;
alter table venues       enable row level security;
alter table venue_sports enable row level security;
alter table sport_areas  enable row level security;

create policy areas_public        on areas        for select using (true);
create policy sports_public       on sports       for select using (true);
create policy venues_public       on venues       for select using (true);
create policy venue_sports_public on venue_sports for select using (true);
create policy sport_areas_public  on sport_areas  for select using (true);
