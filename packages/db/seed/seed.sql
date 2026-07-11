-- seed.sql
-- Leicester, with real coordinates. The distances in the tests are therefore
-- real distances, which means the geo queries are actually being exercised
-- rather than agreeing with numbers I made up.

-- ---------------------------------------------------------------- areas
insert into areas (id, name, centroid) values
  ('LE18', 'Wigston',        ST_MakePoint(-1.0917, 52.5806)::geography),
  ('LE2',  'Leicester South',ST_MakePoint(-1.1300, 52.6100)::geography),
  ('LE3',  'Leicester West', ST_MakePoint(-1.1750, 52.6300)::geography),
  ('LE5',  'Leicester East', ST_MakePoint(-1.0700, 52.6400)::geography),
  ('LE8',  'Blaby',          ST_MakePoint(-1.1400, 52.5500)::geography)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- sports
-- Note every `typical_players` is a SUGGESTION and every preset is a SHORTCUT.
-- Badminton is 4 more often than not. It is never "always 4".
insert into sports (
  id, name, emoji, typical_players, presets, has_teams, has_levels, level_names,
  kit, duration_min, is_outdoor, weather_dependent, season, guides,
  launch_threshold, globally_live
) values
  ('badminton', 'Badminton', '🏸', 4,
   '[{"label":"Singles","n":2},{"label":"Doubles","n":4},{"label":"Rotating","n":6},{"label":"Two courts","n":8}]',
   false, true, '{Beginner,Improver,Intermediate,Advanced}',
   '{"Racket — spares usually available","Non-marking indoor trainers"}',
   60, false, false, 'year-round',
   '[{"title":"Badminton basics in 8 minutes","by":"Badminton Insight","len":"8:12"},
     {"title":"The five shots every beginner needs","by":"BadmintonPros","len":"11:40"}]',
   20, true),

  ('cricket', 'Cricket', '🏏', 12,
   '[{"label":"Nets","n":6},{"label":"Six a side","n":12},{"label":"Eight a side","n":16},{"label":"Full XI","n":22}]',
   true, false, '{}',
   '{"Bat and ball provided","Trainers","Sun cream — optimistic, this is Leicester"}',
   150, true, true, 'summer',
   '[{"title":"Cricket explained for total beginners","by":"Lord''s","len":"9:30"}]',
   20, true),

  ('football', 'Football', '⚽', 10,
   '[{"label":"5 a side","n":10},{"label":"6 a side","n":12},{"label":"7 a side","n":14},{"label":"11 a side","n":22}]',
   true, false, '{}',
   '{"Boots or astro trainers","Bring a light shirt and a dark one"}',
   60, true, true, 'year-round',
   '[{"title":"Five-a-side tactics that actually work","by":"Football Weekly","len":"7:44"}]',
   20, false),

  ('padel', 'Padel', '🎾', 4,
   '[{"label":"Singles","n":2},{"label":"Doubles","n":4},{"label":"Rotating","n":6}]',
   false, true, '{Beginner,Improver,Intermediate,Advanced}',
   '{"Padel bat — courts hire them out","Trainers"}',
   90, true, false, 'year-round',
   '[{"title":"Padel in 10 minutes — rules and scoring","by":"The Padel School","len":"10:05"}]',
   20, false),

  ('tennis', 'Tennis', '🥎', 4,
   '[{"label":"Singles","n":2},{"label":"Doubles","n":4},{"label":"Rotating","n":6}]',
   false, true, '{Beginner,Improver,Intermediate,Advanced}',
   '{"Racket","Balls","Trainers"}',
   60, true, true, 'summer', '[]', 20, false),

  ('pickleball', 'Pickleball', '🥒', 4,
   '[{"label":"Singles","n":2},{"label":"Doubles","n":4},{"label":"Rotating","n":8}]',
   false, true, '{Beginner,Improver,Intermediate,Advanced}',
   '{"Paddle — usually provided","Indoor trainers"}',
   60, false, false, 'year-round', '[]', 20, false),

  ('squash', 'Squash', '🎯', 2,
   '[{"label":"Singles","n":2},{"label":"Three rotating","n":3},{"label":"Four rotating","n":4}]',
   false, true, '{Beginner,Improver,Intermediate,Advanced}',
   '{"Racket","Eye guards","Indoor trainers"}',
   40, false, false, 'year-round', '[]', 20, false),

  ('running', 'Running', '👟', 8,
   '[{"label":"Pair","n":2},{"label":"Small group","n":6},{"label":"Big group","n":15}]',
   false, true, '{"Couch to 5k","5k","10k","Half and up"}',
   '{"Trainers. That''s it."}',
   45, true, true, 'year-round', '[]', 15, false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- venues
-- Real places, real coordinates. Seeded BEFORE a single user exists, which is
-- why the app is never truly empty: it can always tell you WHERE you could
-- play, even when it cannot yet tell you who with.
insert into venues (id, name, address, area_id, location, price_pence, price_unit, booking_url) values
  ('11111111-0000-0000-0000-000000000001', 'Active Wigston',            'Station Rd, Wigston',        'LE18', ST_MakePoint(-1.0894, 52.5822)::geography, 2000, 'hour', 'https://example.invalid/active-wigston'),
  ('11111111-0000-0000-0000-000000000002', 'Wigston Tennis Club',       'Blaby Rd, Wigston',          'LE18', ST_MakePoint(-1.1010, 52.5770)::geography, 1200, 'hour', null),
  ('11111111-0000-0000-0000-000000000003', 'Grace Road nets',           'Aylestone, Leicester',       'LE2',  ST_MakePoint(-1.1394, 52.6122)::geography, 2400, 'hour', null),
  ('11111111-0000-0000-0000-000000000004', 'Evington Park',             'Evington, Leicester',        'LE5',  ST_MakePoint(-1.0817, 52.6208)::geography,    0, '',     null),
  ('11111111-0000-0000-0000-000000000005', 'Aylestone Leisure Centre',  'Knighton Lane East',         'LE2',  ST_MakePoint(-1.1339, 52.6006)::geography, 1600, 'hour', null),
  ('11111111-0000-0000-0000-000000000006', 'Victoria Park',             'Leicester',                  'LE2',  ST_MakePoint(-1.1206, 52.6203)::geography,    0, '',     null),
  ('11111111-0000-0000-0000-000000000007', 'Powerleague Leicester',     'Meridian Way',               'LE3',  ST_MakePoint(-1.1900, 52.6050)::geography, 5500, 'hour', null),
  ('11111111-0000-0000-0000-000000000008', 'Braunstone Leisure Centre', 'Braunstone',                 'LE3',  ST_MakePoint(-1.1731, 52.6136)::geography, 1800, 'hour', null),
  ('11111111-0000-0000-0000-000000000009', 'Leicester Leys Centre',     'Beaumont Leys',              'LE3',  ST_MakePoint(-1.1600, 52.6600)::geography, 2200, 'hour', null),
  ('11111111-0000-0000-0000-00000000000a', 'Padel4All Leicester',       'Meridian Business Park',     'LE3',  ST_MakePoint(-1.1950, 52.6000)::geography, 3200, '90 min', null)
on conflict (id) do nothing;

insert into venue_sports (venue_id, sport_id) values
  ('11111111-0000-0000-0000-000000000001','badminton'),
  ('11111111-0000-0000-0000-000000000001','squash'),
  ('11111111-0000-0000-0000-000000000002','tennis'),
  ('11111111-0000-0000-0000-000000000003','cricket'),
  ('11111111-0000-0000-0000-000000000004','cricket'),
  ('11111111-0000-0000-0000-000000000004','running'),
  ('11111111-0000-0000-0000-000000000005','badminton'),
  ('11111111-0000-0000-0000-000000000005','squash'),
  ('11111111-0000-0000-0000-000000000005','pickleball'),
  ('11111111-0000-0000-0000-000000000006','cricket'),
  ('11111111-0000-0000-0000-000000000006','running'),
  ('11111111-0000-0000-0000-000000000006','football'),
  ('11111111-0000-0000-0000-000000000007','football'),
  ('11111111-0000-0000-0000-000000000008','badminton'),
  ('11111111-0000-0000-0000-000000000008','football'),
  ('11111111-0000-0000-0000-000000000009','badminton'),
  ('11111111-0000-0000-0000-000000000009','football'),
  ('11111111-0000-0000-0000-000000000009','pickleball'),
  ('11111111-0000-0000-0000-00000000000a','padel')
on conflict do nothing;

-- ------------------------------------------------- demand by postcode
-- Football sits at 19 of 20 in LE18. One more person and it opens there --
-- which is the density rule made visible.
insert into sport_areas (sport_id, area_id, want_count, is_live) values
  ('football',  'LE18', 19, false),
  ('football',  'LE2',  16, false),
  ('football',  'LE3',  11, false),
  ('football',  'LE5',  14, false),
  ('padel',     'LE18', 12, false),
  ('padel',     'LE2',   9, false),
  ('padel',     'LE3',   4, false),
  ('tennis',    'LE18',  9, false),
  ('tennis',    'LE2',  13, false),
  ('pickleball','LE18',  4, false),
  ('squash',    'LE18',  6, false),
  ('running',   'LE18', 11, false),
  ('running',   'LE2',  18, false)
on conflict do nothing;

-- ---------------------------------------------------------------- people
-- Fixed UUIDs so tests can address them by name.
-- approx_location is set via app.set_my_area() below, so even the SEED never
-- writes a true position.
insert into profiles (id, display_name, initials, area_id, approx_location,
                      radius_miles, is_new_to_area, is_adult, games_attended, games_missed, is_admin)
values
  ('22222222-0000-0000-0000-000000000001','Shiv','S',   'LE18', ST_MakePoint(-1.0917,52.5806)::geography, 10, false, true,  6,  0, true),
  ('22222222-0000-0000-0000-000000000002','Tom','TM',   'LE18', ST_MakePoint(-1.0930,52.5820)::geography, 10, false, true, 31,  2, false),
  ('22222222-0000-0000-0000-000000000003','Priya','PR', 'LE18', ST_MakePoint(-1.0900,52.5790)::geography, 10, false, true, 23,  1, false),
  ('22222222-0000-0000-0000-000000000004','Dan','DK',   'LE18', ST_MakePoint(-1.0940,52.5840)::geography, 10, false, true,  9,  4, false),
  ('22222222-0000-0000-0000-000000000005','Arjun','AR', 'LE18', ST_MakePoint(-1.0880,52.5780)::geography, 10, true,  true,  4,  0, false),
  ('22222222-0000-0000-0000-000000000006','Meera','ME', 'LE2',  ST_MakePoint(-1.1300,52.6100)::geography, 10, true,  true,  2,  0, false),
  ('22222222-0000-0000-0000-000000000007','Chris','CW', 'LE2',  ST_MakePoint(-1.1320,52.6120)::geography, 15, false, true, 12,  0, false),
  ('22222222-0000-0000-0000-000000000008','Rehan','RJ', 'LE5',  ST_MakePoint(-1.0700,52.6400)::geography, 15, false, true, 18,  1, false),
  -- a person a long way away, to prove the 25-mile cap actually bites
  ('22222222-0000-0000-0000-000000000009','Faraway Fred','FF','LE3', ST_MakePoint(-1.9000,52.4800)::geography, 25, false, true, 3, 0, false)
on conflict (id) do nothing;

insert into profile_sports (profile_id, sport_id, level) values
  ('22222222-0000-0000-0000-000000000001','badminton','Improver'),
  ('22222222-0000-0000-0000-000000000001','cricket',null),
  ('22222222-0000-0000-0000-000000000002','badminton','Intermediate'),
  ('22222222-0000-0000-0000-000000000003','badminton','Intermediate'),
  ('22222222-0000-0000-0000-000000000004','badminton','Improver'),
  ('22222222-0000-0000-0000-000000000004','cricket',null),
  ('22222222-0000-0000-0000-000000000005','badminton','Improver'),
  ('22222222-0000-0000-0000-000000000005','cricket',null),
  ('22222222-0000-0000-0000-000000000006','badminton','Beginner'),
  ('22222222-0000-0000-0000-000000000007','cricket',null),
  ('22222222-0000-0000-0000-000000000008','cricket',null),
  ('22222222-0000-0000-0000-000000000009','badminton','Improver')
on conflict do nothing;

-- ---------------------------------------------------------------- games
-- Two badminton games at DIFFERENT SHAPES, deliberately: Friday doubles is 4,
-- the Tuesday ladder is 6 rotating. Both are badminton. Nothing is fixed.
insert into games (id, sport_id, host_id, venue_id, court, title, starts_at,
                   spots_needed, cost_pence, repeats_weekly, approve_required,
                   beginners_welcome, min_level, split_teams, note, is_booked, host_paid_upfront)
values
  ('33333333-0000-0000-0000-000000000001','badminton',
   '22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','Court 3',
   'Friday doubles', now() + interval '3 days',
   4, 2000, true, false, true, null, false,
   'Chris can''t make it this week. Beginners welcome — we''re really not serious.', true, true),

  ('33333333-0000-0000-0000-000000000002','badminton',
   '22222222-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000005','Courts 1–2',
   'Tuesday singles ladder', now() + interval '5 days',
   6, 1600, true, true, false, 'Intermediate', false,
   'Six of us, rotating singles. Not four — badminton is whatever you make it.', true, true),

  ('33333333-0000-0000-0000-000000000003','cricket',
   '22222222-0000-0000-0000-000000000008','11111111-0000-0000-0000-000000000004','Top field',
   'Sunday tape-ball', now() + interval '2 days',
   12, 0, true, false, true, null, true,
   'Every Sunday, rain or shine. All ages, all abilities. Free.', true, false),

  ('33333333-0000-0000-0000-000000000004','cricket',
   '22222222-0000-0000-0000-000000000007','11111111-0000-0000-0000-000000000003','Net 2',
   'Thursday hardball nets', now() + interval '4 days',
   6, 2400, false, true, false, null, false,
   'Hardball nets. Bring your kit if you''ve got it — spares available.', false, false)
on conflict (id) do nothing;

-- Friday doubles: 3 of 4. One spot. This is the game the whole product exists for.
insert into game_players (game_id, profile_id) values
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002'),
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000003'),
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000004'),
  -- Tuesday ladder: FULL at 6/6, so the waitlist has something to do
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000004'),
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000003'),
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000002'),
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000005'),
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000006'),
  ('33333333-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000009'),
  -- Sunday cricket
  ('33333333-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000008'),
  ('33333333-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000007'),
  ('33333333-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000005'),
  -- Thursday nets (approval game)
  ('33333333-0000-0000-0000-000000000004','22222222-0000-0000-0000-000000000007'),
  ('33333333-0000-0000-0000-000000000004','22222222-0000-0000-0000-000000000005')
on conflict do nothing;

insert into game_regulars (game_id, profile_id) values
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002'),
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000003'),
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000004')
on conflict do nothing;

insert into game_messages (game_id, profile_id, body) values
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002','Chris is out this week, so we''re a player down'),
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000003','I''ve asked at work. Nobody''s biting.'),
  ('33333333-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002','Putting it on Hangout then. Someone will turn up.');
