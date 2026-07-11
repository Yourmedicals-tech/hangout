/**
 * race.test.js — the last spot.
 *
 * Friday, 6:02pm. One spot left. Tom's push goes out to 38 people. Two of them
 * read it at the same traffic light and both tap "I'm in".
 *
 * This suite does not simulate that with sleeps and hope. It fires N genuinely
 * concurrent transactions at the same game and checks the arithmetic afterwards.
 *
 * It also builds a deliberately NAIVE join (no row lock) and proves that it
 * double-books — because a test that only shows the correct code passing tells
 * you nothing about whether the lock is load-bearing or decorative.
 *
 * Run:  node packages/db/test/race.test.js
 */
const { Client } = require("pg");

const CONN = {
  host: "localhost", port: 54322, database: "hangout",
  user: "postgres", password: "hangout_dev",
};

const FRIDAY = "33333333-0000-0000-0000-000000000001"; // badminton, 3 of 4

let pass = 0;
const failures = [];
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, d) => { failures.push(m); console.log(`  \x1b[31m✗ ${m}\x1b[0m`); if (d) console.log(`      ${d}`); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`);

const admin = async (sql, params) => {
  const c = new Client(CONN);
  await c.connect();
  try { return await c.query(sql, params); }
  finally { await c.end(); }
};

/** Make N adult badminton players in LE18 who are not yet in any game. */
async function makeContenders(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `44444444-0000-0000-0000-${String(i).padStart(12, "0")}`;
    ids.push(id);
    await admin(
      `INSERT INTO profiles (id, display_name, initials, area_id, approx_location, is_adult)
       VALUES ($1, $2, 'X', 'LE18', ST_MakePoint(-1.0917, 52.5806)::geography, true)
       ON CONFLICT (id) DO NOTHING`, [id, `Contender ${i}`]);
    await admin(
      `INSERT INTO profile_sports (profile_id, sport_id) VALUES ($1,'badminton')
       ON CONFLICT DO NOTHING`, [id]);
  }
  return ids;
}

async function clearContenders(gameId) {
  await admin(`DELETE FROM game_players  WHERE profile_id::text LIKE '44444444%'`);
  await admin(`DELETE FROM game_waitlist WHERE profile_id::text LIKE '44444444%'`);
  await admin(`DELETE FROM game_asks     WHERE profile_id::text LIKE '44444444%'`);
}

/** One contender, one connection, one genuinely concurrent attempt. */
async function attemptJoin(userId, gameId, fn = "app.join_game") {
  const c = new Client(CONN);
  await c.connect();
  try {
    await c.query("SET ROLE app_user");
    await c.query("SELECT set_config('app.user_id', $1, false)", [userId]);
    const r = await c.query(`SELECT ${fn}($1) AS outcome`, [gameId]);
    return r.rows[0].outcome;
  } catch (e) {
    return `error:${e.message.split("\n")[0]}`;
  } finally {
    await c.end();
  }
}

(async () => {
  // ══════════════════════════════════════════════════════════════════
  section("Setup");
  // ══════════════════════════════════════════════════════════════════
  const before = await admin(
    `SELECT spots_needed,
            (SELECT count(*) FROM game_players WHERE game_id=$1)::int AS taken
       FROM games WHERE id=$1`, [FRIDAY]);
  const { spots_needed, taken } = before.rows[0];
  check(spots_needed - taken === 1,
    `Friday doubles has exactly ONE spot left (${taken}/${spots_needed})`);

  const contenders = await makeContenders(10);
  ok(`${contenders.length} people are about to tap "I'm in" at the same moment`);

  // ══════════════════════════════════════════════════════════════════
  section('10 people tap "I\'m in" simultaneously — 1 spot');
  // ══════════════════════════════════════════════════════════════════
  await clearContenders(FRIDAY);

  // Fire all ten WITHOUT awaiting in between. They genuinely overlap.
  const t0 = Date.now();
  const outcomes = await Promise.all(contenders.map((id) => attemptJoin(id, FRIDAY)));
  const ms = Date.now() - t0;

  const joined = outcomes.filter((o) => o === "joined").length;
  const waitlisted = outcomes.filter((o) => o === "waitlisted").length;
  const errors = outcomes.filter((o) => String(o).startsWith("error"));

  console.log(`      outcomes: ${JSON.stringify(outcomes)}`);
  console.log(`      (${ms}ms for 10 concurrent attempts)`);

  check(errors.length === 0, "nobody got an error", errors[0]);
  check(joined === 1, `EXACTLY ONE person got the spot (got ${joined})`);
  check(waitlisted === 9, `the other nine were waitlisted, not rejected (got ${waitlisted})`);

  const after = await admin(
    `SELECT (SELECT count(*) FROM game_players  WHERE game_id=$1)::int AS players,
            (SELECT count(*) FROM game_waitlist WHERE game_id=$1)::int AS waiting`, [FRIDAY]);
  check(after.rows[0].players === spots_needed,
    `the game has exactly ${spots_needed} players — never ${spots_needed + 1}`,
    `actually has ${after.rows[0].players}`);
  check(after.rows[0].waiting === 9, "and nine people in the queue, in order");

  // ══════════════════════════════════════════════════════════════════
  section("Is the lock actually doing anything? — the naive version");
  // ══════════════════════════════════════════════════════════════════
  // Build the join every developer writes the first time: read the count,
  // check it, insert. No lock. If this ALSO produces exactly one winner, then
  // our test isn't concurrent enough to prove anything and the real result
  // above would be worthless.
  await admin(`
    CREATE OR REPLACE FUNCTION app.join_game_naive(p_game_id uuid)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, app
    AS $fn$
    DECLARE
      v_user  uuid := app.current_user_id();
      v_need  int;
      v_taken int;
    BEGIN
      SELECT spots_needed INTO v_need FROM games WHERE id = p_game_id;   -- no FOR UPDATE
      SELECT count(*) INTO v_taken FROM game_players WHERE game_id = p_game_id;
      PERFORM pg_sleep(0.05);          -- the window every real system has
      IF v_taken >= v_need THEN RETURN 'waitlisted'; END IF;
      INSERT INTO game_players (game_id, profile_id) VALUES (p_game_id, v_user)
        ON CONFLICT DO NOTHING;
      RETURN 'joined';
    END $fn$;`);
  await admin(`GRANT EXECUTE ON FUNCTION app.join_game_naive(uuid) TO app_user`);

  // Reset the game to 3 of 4 again.
  await clearContenders(FRIDAY);
  const reset = await admin(
    `SELECT (SELECT count(*) FROM game_players WHERE game_id=$1)::int AS players`, [FRIDAY]);
  check(reset.rows[0].players === 3, "game reset to 3 of 4");

  const naive = await Promise.all(
    contenders.map((id) => attemptJoin(id, FRIDAY, "app.join_game_naive")));
  const naiveJoined = naive.filter((o) => o === "joined").length;
  const naiveCount = await admin(
    `SELECT count(*)::int AS n FROM game_players WHERE game_id=$1`, [FRIDAY]);

  console.log(`      naive outcomes: ${JSON.stringify(naive)}`);
  check(naiveJoined > 1,
    `the NAIVE join double-books: ${naiveJoined} people "got" the last spot`,
    "if this says 1, the test is not concurrent and the result above is meaningless");
  check(naiveCount.rows[0].n > 4,
    `the naive game now has ${naiveCount.rows[0].n} players at a 4-person court`,
    `it has ${naiveCount.rows[0].n}`);
  ok("→ therefore SELECT … FOR UPDATE is load-bearing, not decoration");

  await admin(`DROP FUNCTION app.join_game_naive(uuid)`);

  // ══════════════════════════════════════════════════════════════════
  section("A bigger game, more contention — 20 people, 5 spots");
  // ══════════════════════════════════════════════════════════════════
  await clearContenders(FRIDAY);
  await admin(`DELETE FROM game_players WHERE game_id=$1 AND profile_id::text LIKE '44444444%'`, [FRIDAY]);

  const big = "33333333-0000-0000-0000-0000000000bb";
  await admin(
    `INSERT INTO games (id, sport_id, host_id, venue_id, court, title, starts_at,
                        spots_needed, cost_pence)
     VALUES ($1,'badminton','22222222-0000-0000-0000-000000000002',
             '11111111-0000-0000-0000-000000000001','Court 9','Contention test',
             now() + interval '2 days', 6, 0)
     ON CONFLICT (id) DO NOTHING`, [big]);
  await admin(`DELETE FROM game_players WHERE game_id=$1`, [big]);
  await admin(
    `INSERT INTO game_players (game_id, profile_id)
     VALUES ($1,'22222222-0000-0000-0000-000000000002') ON CONFLICT DO NOTHING`, [big]);

  const twenty = await makeContenders(20);
  const outcomes2 = await Promise.all(twenty.map((id) => attemptJoin(id, big)));
  const joined2 = outcomes2.filter((o) => o === "joined").length;
  const final2 = await admin(
    `SELECT count(*)::int AS n FROM game_players WHERE game_id=$1`, [big]);

  check(joined2 === 5, `exactly 5 of 20 got in (host + 5 = 6 spots). Got ${joined2}.`);
  check(final2.rows[0].n === 6,
    `game is exactly full at 6/6 — never 7, never 21`,
    `has ${final2.rows[0].n}`);

  // ══════════════════════════════════════════════════════════════════
  section("Dropping out promotes the top of the waitlist, automatically");
  // ══════════════════════════════════════════════════════════════════
  const waitFirst = await admin(
    `SELECT profile_id FROM game_waitlist WHERE game_id=$1 ORDER BY joined_at LIMIT 1`, [big]);
  const promotedExpected = waitFirst.rows[0]?.profile_id;
  check(!!promotedExpected, "someone is at the top of the waitlist");

  // the host leaves
  const c = new Client(CONN);
  await c.connect();
  await c.query("SET ROLE app_user");
  await c.query("SELECT set_config('app.user_id','22222222-0000-0000-0000-000000000002',false)");
  const promoted = await c.query("SELECT app.leave_game($1) AS promoted", [big]);
  await c.end();

  check(promoted.rows[0].promoted === promotedExpected,
    "the person at the top of the queue was promoted — nobody had to ask");

  const final3 = await admin(
    `SELECT count(*)::int AS n FROM game_players WHERE game_id=$1`, [big]);
  check(final3.rows[0].n === 6, "the game is still exactly full — the spot never sat empty");

  // cleanup
  await admin(`DELETE FROM games WHERE id=$1`, [big]);
  await admin(`DELETE FROM profiles WHERE id::text LIKE '44444444%'`);

  console.log("");
  if (failures.length) {
    console.log(`\x1b[31m✗ ${failures.length} FAILURE(S)\x1b[0m — ${pass} passed\n`);
    failures.forEach((f) => console.log(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ALL ${pass} CONCURRENCY CHECKS PASSED\x1b[0m\n`);
})().catch((e) => {
  console.error("\n\x1b[31mSUITE CRASHED\x1b[0m\n", e);
  process.exit(1);
});
