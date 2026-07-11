/**
 * notify.test.js — who gets told.
 *
 * The transport is not the risk. Expo and Apple will deliver the bytes. The
 * risk is the AUDIENCE, and it fails in two directions:
 *
 *   Too narrow → the person who WOULD have turned up never hears, the court
 *                sits empty, and the app has failed at the only job it has.
 *
 *   Too wide   → you ping a beginner about a competitive game 22 miles away.
 *                They turn notifications off. You can now never reach them
 *                again. Same failure, arriving more slowly.
 *
 * Notification permission is a one-way door. So most of these tests assert on
 * who is NOT in the list.
 *
 * Run: node packages/db/test/notify.test.js
 */
const { Client } = require("pg");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CONN = {
  host: "localhost", port: 54322, database: "hangout",
  user: "postgres", password: "hangout_dev",
};

// This suite MUTATES seed data (drops players, moves people, flips levels), so
// it reseeds first. A test that only passes on a pristine database is a test
// that will one day pass for the wrong reason — or fail for no reason at all,
// at 2am, and be dismissed as flaky.
execFileSync(path.join(__dirname, "..", "reset.sh"), { stdio: "ignore" });

const TOM = "22222222-0000-0000-0000-000000000002"; // hosts Friday doubles, IS in it
const PRIYA = "22222222-0000-0000-0000-000000000003"; // IS in Friday doubles
const DAN = "22222222-0000-0000-0000-000000000004"; // IS in Friday doubles
const ARJUN = "22222222-0000-0000-0000-000000000005"; // badminton, LE18, NOT in it
const MEERA = "22222222-0000-0000-0000-000000000006"; // badminton BEGINNER, LE2
const SHIV = "22222222-0000-0000-0000-000000000001"; // badminton, LE18
const FRED = "22222222-0000-0000-0000-000000000009"; // badminton, but 40 MILES away
const REHAN = "22222222-0000-0000-0000-000000000008"; // cricket only

const FRIDAY = "33333333-0000-0000-0000-000000000001"; // badminton, any level
const LADDER = "33333333-0000-0000-0000-000000000002"; // badminton, INTERMEDIATE+

let pass = 0;
const failures = [];
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, d) => { failures.push(m); console.log(`  \x1b[31m✗ ${m}\x1b[0m`); if (d) console.log(`      ${d}`); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`);

const q = async (sql, params) => {
  const c = new Client(CONN);
  await c.connect();
  try { return await c.query(sql, params); }
  finally { await c.end(); }
};

const targets = async (gameId) => {
  const r = await q(
    `SELECT p.id, p.display_name FROM app.notify_targets($1) t
       JOIN profiles p ON p.id = t.profile_id ORDER BY p.display_name`, [gameId]);
  return r.rows;
};
const names = (rows) => rows.map((r) => r.display_name).join(", ") || "(nobody)";
const has = (rows, id) => rows.some((r) => r.id === id);

(async () => {
  // ══════════════════════════════════════════════════════════════════
  section("Who gets told about the Friday badminton spot");
  // ══════════════════════════════════════════════════════════════════
  let t = await targets(FRIDAY);
  console.log(`      audience: ${names(t)}`);

  check(has(t, ARJUN), "Arjun IS told — plays badminton, 0.8 miles away, not in it");
  check(has(t, SHIV), "Shiv IS told — plays badminton, in LE18");

  // ---- and now everybody we are deliberately NOT waking up ----
  check(!has(t, TOM), "the HOST is not told — he knows, he posted it");
  check(!has(t, PRIYA), "someone already IN the game is not told");
  check(!has(t, DAN), "…nor another player already in it");
  check(!has(t, REHAN), "a cricket-only player is not told about badminton");
  check(!has(t, FRED),
    "Fred (40 miles away) is NOT told — the venue is outside the radius he chose");

  // ══════════════════════════════════════════════════════════════════
  section("Level — pinging a beginner about a competitive game is a small cruelty");
  // ══════════════════════════════════════════════════════════════════
  // The Tuesday ladder is "Intermediate and up". Meera is a Beginner.
  t = await targets(LADDER);
  check(!has(t, MEERA),
    "Meera (Beginner) is NOT told about the Intermediate-and-up ladder",
    "she is in the game already OR excluded by level — either way, not pinged");

  // Make it unambiguous: pull Meera out of the ladder, then re-check.
  await q("DELETE FROM game_players WHERE game_id=$1 AND profile_id=$2", [LADDER, MEERA]);
  t = await targets(LADDER);
  check(!has(t, MEERA),
    "…still not told, even with a free spot — because she is below the level asked for");
  const arjunLevel = await q(
    "SELECT level FROM profile_sports WHERE profile_id=$1 AND sport_id='badminton'", [ARJUN]);
  check(arjunLevel.rows[0].level === "Improver", "setup: Arjun is an Improver");
  check(!has(t, ARJUN),
    "Arjun (Improver) is also NOT told — Improver is below Intermediate");

  // Promote Meera and she should now hear about it.
  await q("UPDATE profile_sports SET level='Advanced' WHERE profile_id=$1 AND sport_id='badminton'", [MEERA]);
  t = await targets(LADDER);
  check(has(t, MEERA), "…but an Advanced player IS told about the same game");
  await q("UPDATE profile_sports SET level='Beginner' WHERE profile_id=$1 AND sport_id='badminton'", [MEERA]);

  // ══════════════════════════════════════════════════════════════════
  section("Notification preference is honoured, not overridden");
  // ══════════════════════════════════════════════════════════════════
  await q("UPDATE profiles SET notify = false WHERE id=$1", [ARJUN]);
  t = await targets(FRIDAY);
  check(!has(t, ARJUN), "a person with notifications OFF is never enqueued");
  await q("UPDATE profiles SET notify = true WHERE id=$1", [ARJUN]);

  // ══════════════════════════════════════════════════════════════════
  section("Radius is THEIR choice, not ours");
  // ══════════════════════════════════════════════════════════════════
  // Shiv plays cricket and lives 2.8 miles from the Sunday game at Evington.
  // A person who set "1 mile" MEANT it. Pinging them about a game they'd never
  // travel to is how you lose notification permission, permanently.
  const SUNDAY = "33333333-0000-0000-0000-000000000003";

  await q("UPDATE profiles SET radius_miles = 10 WHERE id=$1", [SHIV]);
  let wide = await targets(SUNDAY);
  check(has(wide, SHIV), "at 10 miles, Shiv IS told about cricket 2.8 miles away");

  await q("UPDATE profiles SET radius_miles = 1 WHERE id=$1", [SHIV]);
  let narrow = await targets(SUNDAY);
  check(!has(narrow, SHIV),
    "at 1 mile, the SAME game is silent — his radius is his choice, not ours",
    "if this passes at both radii the test proves nothing");
  check(wide.length > narrow.length,
    `and the audience genuinely shrank (${wide.length} → ${narrow.length})`);

  await q("UPDATE profiles SET radius_miles = 10 WHERE id=$1", [SHIV]);

  // ══════════════════════════════════════════════════════════════════
  section("The outbox — the transaction writes a row, and sends nothing");
  // ══════════════════════════════════════════════════════════════════
  await q("DELETE FROM notifications");

  // Priya drops out of the Friday game.
  const c = new Client(CONN);
  await c.connect();
  await c.query("SET ROLE app_user");
  await c.query("SELECT set_config('app.user_id', $1, false)", [PRIYA]);
  await c.query("SELECT app.leave_game($1)", [FRIDAY]);
  await c.end();

  const notes = await q(
    `SELECT n.*, p.display_name FROM notifications n
       JOIN profiles p ON p.id = n.profile_id
      WHERE n.kind='spot_open' ORDER BY p.display_name`);
  check(notes.rowCount > 0, `dropping out enqueued ${notes.rowCount} notifications`);
  console.log(`      told: ${notes.rows.map((r) => r.display_name).join(", ")}`);
  console.log(`      title: "${notes.rows[0]?.title}"`);
  console.log(`      body:  "${notes.rows[0]?.body}"`);

  check(notes.rows.every((r) => r.sent_at === null),
    "every row is UNSENT — the database enqueued, it did not send");
  check(!notes.rows.some((r) => r.profile_id === PRIYA),
    "the person who dropped out is not told about their own departure");

  // ══════════════════════════════════════════════════════════════════
  section("THE PUSH BODY MUST NOT LEAK THE VENUE");
  // ══════════════════════════════════════════════════════════════════
  // A push is read on a lock screen, in public, by whoever is looking over your
  // shoulder. The disclosure ladder does not get a holiday because the text is
  // short.
  const leaked = notes.rows.filter(
    (r) => /Active Wigston|Court 3|Station Rd/i.test(`${r.title} ${r.body}`));
  check(leaked.length === 0,
    "no spot_open push contains the venue name, the court, or the address",
    leaked[0] ? `LEAKED: "${leaked[0].body}"` : "");
  check(/miles away/.test(notes.rows[0]?.body ?? ""),
    "…it says how far, which is what you need to decide");

  // ...but once the host lets you IN, you are a member, and you may be told where.
  await q("DELETE FROM notifications");
  const NETS = "33333333-0000-0000-0000-000000000004";
  const c2 = new Client(CONN);
  await c2.connect();
  await c2.query("SET ROLE app_user");
  await c2.query("SELECT set_config('app.user_id','22222222-0000-0000-0000-000000000007',false)"); // Chris hosts
  await c2.query("SELECT app.accept_ask($1,$2)", [NETS, SHIV]);
  await c2.end();

  const letIn = await q("SELECT * FROM notifications WHERE kind='let_in'");
  check(letIn.rowCount === 1, "being let in enqueues exactly one notification, to you");
  check(/Grace Road/i.test(letIn.rows[0].body),
    `…and NOW it names the venue: "${letIn.rows[0].body}"`);

  // ══════════════════════════════════════════════════════════════════
  section("Waitlist first, shout second — never both");
  // ══════════════════════════════════════════════════════════════════
  await q("DELETE FROM notifications");
  // Put Arjun on the waitlist for the (now full) Friday game, then have Dan leave.
  // Priya left earlier, so this game is 2/4. Refill it properly before testing
  // the "full game loses a player" path.
  await q("INSERT INTO game_players (game_id, profile_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [FRIDAY, ARJUN]);
  await q("INSERT INTO game_players (game_id, profile_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [FRIDAY, PRIYA]);
  const full = await q(
    `SELECT spots_needed, (SELECT count(*) FROM game_players WHERE game_id=$1)::int AS n
       FROM games WHERE id=$1`, [FRIDAY]);
  check(full.rows[0].n === full.rows[0].spots_needed, "Friday game is full again");

  await q("INSERT INTO game_waitlist (game_id, profile_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [FRIDAY, MEERA]);

  const c3 = new Client(CONN);
  await c3.connect();
  await c3.query("SET ROLE app_user");
  await c3.query("SELECT set_config('app.user_id', $1, false)", [DAN]);
  await c3.query("SELECT app.leave_game($1)", [FRIDAY]);
  await c3.end();

  const kinds = await q("SELECT kind, count(*)::int AS n FROM notifications GROUP BY kind");
  const byKind = Object.fromEntries(kinds.rows.map((r) => [r.kind, r.n]));
  check(!byKind.spot_open,
    "when the WAITLIST fills the spot, NOBODY gets a 'spot open' shout",
    "the spot never existed for anyone else — shouting about it would be a lie");
  check(byKind.let_in === 1, "…instead, exactly one person is told they are in");

  console.log("");
  if (failures.length) {
    console.log(`\x1b[31m✗ ${failures.length} FAILURE(S)\x1b[0m — ${pass} passed\n`);
    failures.forEach((f) => console.log(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ALL ${pass} NOTIFICATION CHECKS PASSED\x1b[0m\n`);
})().catch((e) => { console.error("\nSUITE CRASHED\n", e); process.exit(1); });
