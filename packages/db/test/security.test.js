/**
 * security.test.js — the tests that try to break in.
 *
 * These are not "does the query return rows" tests. They are adversarial: they
 * take the position of a stranger who has joined nothing, and try to find out
 * where four people will be on Friday night.
 *
 * Every connection is made as `app_user`, NOT `postgres`. Superusers bypass RLS
 * silently, so a suite that runs as postgres proves nothing at all.
 *
 * Run:  node packages/db/test/security.test.js
 */
const { Client } = require("pg");
const assert = require("node:assert/strict");

const CONN = {
  host: "localhost",
  port: 54322,
  database: "hangout",
  user: "postgres",
  password: "hangout_dev",
};

const SHIV = "22222222-0000-0000-0000-000000000001"; // admin, LE18
const TOM = "22222222-0000-0000-0000-000000000002"; // hosts Friday doubles
const PRIYA = "22222222-0000-0000-0000-000000000003"; // IS in Friday doubles
const ARJUN = "22222222-0000-0000-0000-000000000005"; // NOT in Friday doubles
const MEERA = "22222222-0000-0000-0000-000000000006"; // LE2
const FRED = "22222222-0000-0000-0000-000000000009"; // 40+ miles away

const FRIDAY = "33333333-0000-0000-0000-000000000001"; // badminton, 3/4, open
const LADDER = "33333333-0000-0000-0000-000000000002"; // badminton, 6/6, FULL
const NETS = "33333333-0000-0000-0000-000000000004"; // cricket, approval required

let pass = 0;
const failures = [];

function ok(msg) {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function bad(msg, detail) {
  failures.push(msg);
  console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
  if (detail) console.log(`      ${detail}`);
}
function check(cond, msg, detail) {
  cond ? ok(msg) : bad(msg, detail);
}
function section(t) {
  console.log(`\n\x1b[1m── ${t}\x1b[0m`);
}

/**
 * Assert a statement is REFUSED, without poisoning the transaction.
 * A failed statement inside a txn aborts the whole txn, so every expected
 * rejection has to be fenced with a savepoint or the next query dies with
 * "current transaction is aborted" and the test lies to you about why.
 */
async function refuses(c, sql, params, pattern, msg) {
  await c.query("SAVEPOINT probe");
  try {
    await c.query(sql, params);
    await c.query("ROLLBACK TO SAVEPOINT probe");
    bad(msg, "the statement was ALLOWED — it should have been refused");
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT probe");
    if (pattern.test(e.message)) ok(`${msg} — refused: "${e.message.split("\n")[0]}"`);
    else bad(msg, `refused, but for the wrong reason: ${e.message}`);
  }
}

/** Run fn as a given user, with RLS genuinely in force. */
async function asUser(userId, fn) {
  const c = new Client(CONN);
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE app_user"); // <- drops superuser; RLS now applies
    await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
}

(async () => {
  // ══════════════════════════════════════════════════════════════════
  section("The role itself — if this fails, every test below is a lie");
  // ══════════════════════════════════════════════════════════════════
  await asUser(ARJUN, async (c) => {
    const r = await c.query("SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass");
    check(r.rows[0].current_user === "app_user", "tests run as app_user, not postgres");
    check(r.rows[0].bypass === false, "app_user does NOT have BYPASSRLS — policies are real");
  });

  // ══════════════════════════════════════════════════════════════════
  section("DISCLOSURE LADDER — a stranger tries to find the venue");
  // ══════════════════════════════════════════════════════════════════
  await asUser(ARJUN, async (c) => {
    // Arjun is NOT in Friday doubles. He is a stranger to that game.
    const inGame = await c.query(
      "SELECT 1 FROM game_players WHERE game_id=$1 AND profile_id=$2", [FRIDAY, ARJUN]);
    check(inGame.rowCount === 0, "setup: Arjun is not in the Friday game");

    // 1. The raw row, which carries venue_id and court.
    const raw = await c.query("SELECT * FROM games WHERE id=$1", [FRIDAY]);
    check(raw.rowCount === 0,
      "raw `games` row is INVISIBLE to a non-member (no venue_id, no court)",
      `got ${raw.rowCount} rows — venue_id would be exposed`);

    // 2. game_detail — the full view. RLS should give him nothing.
    const detail = await c.query("SELECT * FROM game_detail WHERE id=$1", [FRIDAY]);
    check(detail.rowCount === 0,
      "game_detail returns ZERO rows — not a filtered answer, no answer");

    // 3. The roster. Names pinned to a time and place is the actual danger.
    const roster = await c.query("SELECT * FROM game_players WHERE game_id=$1", [FRIDAY]);
    check(roster.rowCount === 0, "roster names are invisible to a non-member");

    // 4. The group chat — how you'd learn where four people will be on Friday.
    const chat = await c.query("SELECT * FROM game_messages WHERE game_id=$1", [FRIDAY]);
    check(chat.rowCount === 0, "group chat is invisible to a non-member");

    // 5. But he MUST be able to decide. games_public should give him enough.
    const pub = await c.query(
      `SELECT sport_id, title, starts_at, cost_pence, spots_needed, player_count,
              spots_left, area_id, area_name, host_attended, host_missed, i_am_in
         FROM games_public WHERE id=$1`, [FRIDAY]);
    check(pub.rowCount === 1, "games_public DOES show him the game — he can still decide");
    const g = pub.rows[0];
    check(g.player_count === 3 && g.spots_left === 1,
      `sees the headcount: ${g.player_count}/${g.spots_needed}, ${g.spots_left} spot left`);
    check(g.area_name === "Wigston", "sees the coarse district ('Wigston') — not the building");
    check(g.cost_pence === 2000, "sees the cost");
    check(Number(g.host_attended) === 31 && Number(g.host_missed) === 2,
      "sees the HOST'S RECORD (31 of 33) without learning the host's name");
    check(g.i_am_in === false, "knows he is not in it");

    // 6. The view must be structurally incapable of leaking, not merely filtered.
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='games_public'`);
    const names = cols.rows.map((r) => r.column_name);
    check(!names.includes("venue_name") && !names.includes("court") && !names.includes("host_id"),
      "games_public has NO venue_name / court / host_id column at all",
      `columns: ${names.join(", ")}`);
  });

  // ══════════════════════════════════════════════════════════════════
  section("…and the same person, once they are IN");
  // ══════════════════════════════════════════════════════════════════
  await asUser(PRIYA, async (c) => {
    const detail = await c.query(
      "SELECT venue_name, court, venue_address FROM game_detail WHERE id=$1", [FRIDAY]);
    check(detail.rowCount === 1, "a member CAN read game_detail");
    check(detail.rows[0].venue_name === "Active Wigston",
      `member sees the exact venue: ${detail.rows[0].venue_name}`);
    check(detail.rows[0].court === "Court 3", "member sees the court number");

    const roster = await c.query(
      `SELECT p.display_name FROM game_players gp
         JOIN profiles p ON p.id = gp.profile_id
        WHERE gp.game_id=$1 ORDER BY p.display_name`, [FRIDAY]);
    check(roster.rowCount === 3,
      `member sees the roster by name: ${roster.rows.map((r) => r.display_name).join(", ")}`);

    const chat = await c.query("SELECT body FROM game_messages WHERE game_id=$1", [FRIDAY]);
    check(chat.rowCount === 3, "member sees the group chat");
  });

  // ══════════════════════════════════════════════════════════════════
  section("PRIVACY — there is no true location to steal");
  // ══════════════════════════════════════════════════════════════════
  await asUser(SHIV, async (c) => {
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='profiles' AND column_name ILIKE '%locat%'`);
    check(cols.rowCount === 1 && cols.rows[0].column_name === "approx_location",
      "profiles has exactly ONE location column, and it is named approx_location",
      `found: ${cols.rows.map((r) => r.column_name).join(", ")}`);

    // People near me must return BANDS, never a decimal.
    const near = await c.query("SELECT * FROM people_near_me ORDER BY display_name");
    check(near.rowCount > 0, `people_near_me returns ${near.rowCount} people`);
    const numeric = near.rows.some((r) => /\d+\.\d+/.test(String(r.distance_band)));
    check(!numeric,
      `distances are BANDS, never decimals: ${[...new Set(near.rows.map((r) => r.distance_band))].join(" / ")}`);
    const hasDistCol = Object.keys(near.rows[0]).some((k) => /distance_(miles|metres|m)$/.test(k));
    check(!hasDistCol, "people_near_me has no exact-distance column to trilaterate from");
  });

  // ══════════════════════════════════════════════════════════════════
  section("25-MILE CAP — enforced in the database, not the client");
  // ══════════════════════════════════════════════════════════════════
  await asUser(SHIV, async (c) => {
    await refuses(c, "UPDATE profiles SET radius_miles = 60 WHERE id = $1", [SHIV],
      /radius_miles/, "a client CANNOT write a 60-mile radius");
    await refuses(c, "SELECT app.set_my_area('LE18', 40)", [],
      /capped at 25/, "app.set_my_area() refuses 40 miles");
  });

  await asUser(FRED, async (c) => {
    // Fred is ~40 miles away with the max 25-mile radius. He must see nothing.
    const games = await c.query("SELECT id, distance_miles FROM games_near_me");
    check(games.rowCount === 0,
      "a person 40 miles away sees ZERO games even at max radius — the cap bites",
      `saw ${games.rowCount}`);
  });

  await asUser(SHIV, async (c) => {
    const games = await c.query(
      "SELECT title, distance_miles, area_name FROM games_near_me ORDER BY distance_miles");
    check(games.rowCount > 0, `Shiv (LE18, 10mi) sees ${games.rowCount} games`);
    const far = games.rows.filter((r) => Number(r.distance_miles) > 10);
    check(far.length === 0, "…and none of them are beyond his radius");
    console.log(`      ${games.rows.map((r) => `${r.title} (${r.distance_miles}mi)`).join(", ")}`);
  });

  // ══════════════════════════════════════════════════════════════════
  section("DENSITY — a sport you cannot play here is not offered here");
  // ══════════════════════════════════════════════════════════════════
  await asUser(SHIV, async (c) => {
    const live = await c.query("SELECT app.sport_is_live('padel','LE18') AS live");
    check(live.rows[0].live === false, "padel is NOT live in LE18 (12 of 20)");
    const bad = await c.query("SELECT app.sport_is_live('badminton','LE18') AS live");
    check(bad.rows[0].live === true, "badminton IS live (launched globally)");
  });

  // ══════════════════════════════════════════════════════════════════
  section("HOST approves joiners — the admin is never in this loop");
  // ══════════════════════════════════════════════════════════════════
  await asUser(MEERA, async (c) => {
    // Meera is a cricket-less LE2 user; give her cricket so she can try the nets
    await c.query("INSERT INTO profile_sports(profile_id,sport_id) VALUES($1,'cricket') ON CONFLICT DO NOTHING", [MEERA]);
    const r = await c.query("SELECT app.join_game($1) AS outcome", [NETS]);
    check(r.rows[0].outcome === "asked",
      "joining an approval game returns 'asked', not 'joined'");

    // and she still cannot see the venue while she waits
    const detail = await c.query("SELECT venue_name FROM game_detail WHERE id=$1", [NETS]);
    check(detail.rowCount === 0,
      "…and the venue stays hidden while the host has not yet let her in");
  });

  // ══════════════════════════════════════════════════════════════════
  section("18+ — enforced, not asked");
  // ══════════════════════════════════════════════════════════════════
  {
    const c = new Client(CONN);
    await c.connect();
    const KID = "22222222-0000-0000-0000-0000000000ff";
    await c.query(
      `INSERT INTO profiles (id, display_name, initials, area_id, approx_location, is_adult)
       VALUES ($1,'Minor','MI','LE18', ST_MakePoint(-1.09,52.58)::geography, false)
       ON CONFLICT (id) DO NOTHING`, [KID]);
    await c.query("INSERT INTO profile_sports(profile_id,sport_id) VALUES($1,'badminton') ON CONFLICT DO NOTHING", [KID]);
    await c.end();

    await asUser(KID, async (c) => {
      await refuses(c, "SELECT app.join_game($1)", [FRIDAY],
        /18 or over/, "a profile without is_adult CANNOT join a game");
    });

    const cleanup = new Client(CONN);
    await cleanup.connect();
    await cleanup.query("DELETE FROM profiles WHERE id=$1", [KID]);
    await cleanup.end();
  }

  // ══════════════════════════════════════════════════════════════════
  console.log("");
  if (failures.length) {
    console.log(`\x1b[31m✗ ${failures.length} FAILURE(S)\x1b[0m — ${pass} passed\n`);
    failures.forEach((f) => console.log(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ALL ${pass} SECURITY CHECKS PASSED\x1b[0m\n`);
})().catch((e) => {
  console.error("\n\x1b[31mSUITE CRASHED\x1b[0m\n", e);
  process.exit(1);
});
