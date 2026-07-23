/**
 * safety.test.js — block, report, delete.
 *
 * A block that works on one screen is not a block. The whole test is: after A
 * blocks B, is there ANY surface left where they can still find each other?
 */
const { Client } = require("pg");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
execFileSync(path.join(__dirname, "..", "reset.sh"), { stdio: "ignore" });

const CONN = { host: "localhost", port: 54322, database: "hangout", user: "postgres", password: "hangout_dev" };

const SHIV = "22222222-0000-0000-0000-000000000001";
const TOM = "22222222-0000-0000-0000-000000000002";  // hosts Friday doubles
const ARJUN = "22222222-0000-0000-0000-000000000005";
const FRIDAY = "33333333-0000-0000-0000-000000000001";

let pass = 0; const failures = [];
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, d) => { failures.push(m); console.log(`  \x1b[31m✗ ${m}\x1b[0m`); if (d) console.log("      " + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`);

const q = async (sql, p) => {
  const c = new Client(CONN); await c.connect();
  try { return await c.query(sql, p); } finally { await c.end(); }
};
const asUser = async (id, fn) => {
  const c = new Client(CONN); await c.connect();
  try {
    await c.query("SET ROLE app_user");
    await c.query("SELECT set_config('app.user_id', $1, false)", [id]);
    return await fn(c);
  } finally { await c.end(); }
};

(async () => {
  section("Before the block, they can see each other");
  await asUser(SHIV, async (c) => {
    const p = await c.query("SELECT 1 FROM people_near_me WHERE id=$1", [TOM]);
    check(p.rowCount === 1, "Shiv can see Tom in People near you");
    const g = await c.query("SELECT 1 FROM games_near_me WHERE id=$1", [FRIDAY]);
    check(g.rowCount === 1, "…and Tom's Friday game is in his feed");
  });

  section("Shiv blocks Tom. Now check EVERY surface.");
  await asUser(SHIV, (c) => c.query("SELECT app.block_user($1)", [TOM]));

  await asUser(SHIV, async (c) => {
    const p = await c.query("SELECT 1 FROM people_near_me WHERE id=$1", [TOM]);
    check(p.rowCount === 0, "People near you: Tom is gone");
    const g = await c.query("SELECT 1 FROM games_near_me WHERE id=$1", [FRIDAY]);
    check(g.rowCount === 0, "Feed: Tom's game is gone");
    const pub = await c.query("SELECT host_blocked FROM games_public WHERE id=$1", [FRIDAY]);
    check(pub.rows[0]?.host_blocked === true, "games_public flags it as blocked");
  });

  section("…and symmetrically, from Tom's side — he never chose this");
  await asUser(TOM, async (c) => {
    const p = await c.query("SELECT 1 FROM people_near_me WHERE id=$1", [SHIV]);
    check(p.rowCount === 0,
      "Tom cannot see Shiv either — one-way blocking leaves the blocked person watching you");
  });

  section("Blocking cannot be walked around");
  await asUser(SHIV, async (c) => {
    // no BEGIN here, so a failed statement poisons nothing — no savepoint needed
    try {
      await c.query("SELECT app.join_game($1)", [FRIDAY]);
      bad("joining a blocked host's game must be refused");
    } catch (e) {
      check(/unavailable/.test(e.message),
        `cannot join a blocked host's game — "${e.message.split("\n")[0]}"`);
      check(!/block/i.test(e.message),
        "…and the error does NOT say 'blocked' — never confirm a block to the other party");
    }
  });

  section("The push respects it too");
  const targets = await q(
    "SELECT profile_id FROM app.notify_targets($1)", [FRIDAY]);
  check(!targets.rows.some((r) => r.profile_id === SHIV),
    "Shiv is not notified about a game hosted by someone he blocked");

  section("Blocking someone you already share a game with actually separates you");
  await q("INSERT INTO game_players (game_id, profile_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [FRIDAY, ARJUN]);
  const before = await q("SELECT 1 FROM game_players WHERE game_id=$1 AND profile_id=$2", [FRIDAY, ARJUN]);
  check(before.rowCount === 1, "setup: Arjun is in Tom's game");
  await asUser(ARJUN, (c) => c.query("SELECT app.block_user($1)", [TOM]));
  const after = await q("SELECT 1 FROM game_players WHERE game_id=$1 AND profile_id=$2", [FRIDAY, ARJUN]);
  check(after.rowCount === 0,
    "blocking the host removes you from their game",
    "leaving you both on the roster is a block that looks like it worked and didn't");

  section("Reporting also blocks — nobody wants to keep seeing who they reported");
  await asUser(SHIV, (c) =>
    c.query("SELECT app.report_user($1,$2,$3,$4)", [ARJUN, "harassment", "aggressive messages", FRIDAY]));
  const rep = await q("SELECT * FROM reports WHERE reported_id=$1", [ARJUN]);
  check(rep.rowCount === 1, "the report is filed");
  check(rep.rows[0].handled_at === null, "…and sits unhandled, which is the admin queue");
  const blocked = await q(
    "SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2", [SHIV, ARJUN]);
  check(blocked.rowCount === 1, "…and reporting blocked them in the same move");

  section("A stranger cannot read anyone else's reports");
  await asUser(TOM, async (c) => {
    const r = await c.query("SELECT * FROM reports");
    check(r.rowCount === 0, "Tom (not admin, not the reporter) sees zero reports");
  });
  await asUser(SHIV, async (c) => {
    const r = await c.query("SELECT * FROM reports");
    check(r.rowCount >= 1, "…but Shiv is an admin, so the queue is visible to him");
  });

  section("Sign-up puts you in the right place — in METRES, not degrees");
  // ST_Project on ::geometry in SRID 4326 takes DEGREES. 500 of them puts a new
  // user 9,000 km away, and the app looks completely empty to everyone who ever
  // signs up. Seed rows set approx_location directly, so nothing exercised this
  // path until sign-up existed. Never again.
  for (let i = 1; i <= 5; i++) {
    await q("SELECT app.create_profile($1::uuid,$2,'LE18',true)",
      [`99999999-0000-0000-0000-00000000000${i}`, `Test${i}`]);
  }
  const placed = await q(`SELECT display_name,
      ST_Distance(approx_location,(SELECT centroid FROM areas WHERE id='LE18'))::int AS m,
      (SELECT count(*) FROM venues v WHERE ST_DWithin(v.location,p.approx_location,16093))::int AS venues
    FROM profiles p WHERE display_name LIKE 'Test%'`);
  const far = placed.rows.filter((r) => r.m > 500);
  check(far.length === 0,
    `all 5 new users are within 500m of the district centre (max ${Math.max(...placed.rows.map((r) => r.m))}m)`,
    far.length ? `${far[0].display_name} landed ${far[0].m}m away — degrees-vs-metres bug is back` : "");
  check(placed.rows.every((r) => r.venues === 10),
    "…and every one of them can see all 10 venues — the app is not empty on sign-up");
  const distinct = new Set(placed.rows.map((r) => r.m)).size;
  check(distinct === placed.rowCount,
    "…and no two share a point, which would itself be a tell");
  await q("DELETE FROM profiles WHERE display_name LIKE 'Test%'");

  section("Under-18 cannot create a profile at all");
  try {
    await q("SELECT app.create_profile($1::uuid,'Kid','LE18',false)",
      ["99999999-0000-0000-0000-0000000000ff"]);
    bad("an under-18 must not get a profile");
  } catch (e) {
    check(/18 or over/.test(e.message), "sign-up refuses without the 18+ confirmation");
  }

  section("Delete my account — in-app, immediate (Guideline 5.1.1(v))");
  const hosted = await q("SELECT count(*)::int n FROM games WHERE host_id=$1", [TOM]);
  check(hosted.rows[0].n > 0, `setup: Tom hosts ${hosted.rows[0].n} game(s)`);

  await asUser(TOM, (c) => c.query("SELECT app.delete_my_account()"));

  const gone = await q("SELECT count(*)::int n FROM profiles WHERE id=$1", [TOM]);
  check(gone.rows[0].n === 0, "the profile is gone");
  const games = await q("SELECT count(*)::int n FROM games WHERE host_id=$1", [TOM]);
  check(games.rows[0].n === 0, "…and the games he hosted went with him, not orphaned");
  const orphanBlocks = await q(
    "SELECT count(*)::int n FROM blocks WHERE blocker_id=$1 OR blocked_id=$1", [TOM]);
  check(orphanBlocks.rows[0].n === 0, "…and his blocks cascaded away");

  console.log("");
  if (failures.length) {
    console.log(`\x1b[31m✗ ${failures.length} FAILURE(S)\x1b[0m — ${pass} passed\n`);
    failures.forEach((f) => console.log(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ALL ${pass} SAFETY CHECKS PASSED\x1b[0m\n`);
})().catch((e) => { console.error("\nSUITE CRASHED\n", e); process.exit(1); });
