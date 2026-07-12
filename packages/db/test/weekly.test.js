/**
 * weekly.test.js — the standing fixture.
 *
 * The one assumption that must never creep in: SILENCE IS NOT A YES.
 * An unanswered regular is a question, never an attendance. Get that wrong and
 * the host turns up to a booked court expecting six people and finds two.
 */
const { Client } = require("pg");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CONN = { host: "localhost", port: 54322, database: "hangout", user: "postgres", password: "hangout_dev" };
execFileSync(path.join(__dirname, "..", "reset.sh"), { stdio: "ignore" });

const TOM = "22222222-0000-0000-0000-000000000002";
const PRIYA = "22222222-0000-0000-0000-000000000003";
const DAN = "22222222-0000-0000-0000-000000000004";
const FRIDAY = "33333333-0000-0000-0000-000000000001";  // recurring, regulars: tom, priya, dan

let pass = 0;
const failures = [];
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, d) => { failures.push(m); console.log(`  \x1b[31m✗ ${m}\x1b[0m`); if (d) console.log(`      ${d}`); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`);

const q = async (sql, params) => {
  const c = new Client(CONN);
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};
const asUser = async (id, sql, params) => {
  const c = new Client(CONN);
  await c.connect();
  try {
    await c.query("SET ROLE app_user");
    await c.query("SELECT set_config('app.user_id', $1, false)", [id]);
    return await c.query(sql, params);
  } finally { await c.end(); }
};
const prompts = async (id) => (await asUser(id, "SELECT * FROM my_weekly_prompts")).rows;

(async () => {
  section("An unanswered regular is a QUESTION, never an attendance");

  // Seed: Friday doubles has regulars tom/priya/dan, and tom/priya/dan are all
  // on the roster. Take Priya OFF the roster — she is now a regular who has not
  // yet answered for this week.
  await q("DELETE FROM game_players WHERE game_id=$1 AND profile_id=$2", [FRIDAY, PRIYA]);

  let p = await prompts(PRIYA);
  check(p.length === 1, "Priya (regular, hasn't answered) IS asked");
  check(p[0].game_id === FRIDAY, "…about the Friday game");
  console.log(`      "${p[0].title} — are you in?"  ${p[0].player_count} in so far, ${p[0].spots_left} spot(s) left`);

  const tomPrompts = await prompts(TOM);
  check(tomPrompts.length === 0,
    "Tom (regular, already on the roster) is NOT asked — he has answered");

  section("Answering makes the question go away — either way");

  // ...say YES
  await asUser(PRIYA, "SELECT app.join_game($1)", [FRIDAY]);
  p = await prompts(PRIYA);
  check(p.length === 0, "after saying 'I'm in', the prompt disappears");

  // ...and now say NO instead
  await asUser(PRIYA, "SELECT app.cant_make_it($1)", [FRIDAY]);
  p = await prompts(PRIYA);
  check(p.length === 0,
    "after saying \"can't make it\", the prompt ALSO disappears",
    "a prompt that lingers after you answer is a prompt people learn to ignore");

  const absent = await q(
    `SELECT 1 FROM game_absences WHERE game_id=$1 AND profile_id=$2
      AND week_of = app.week_of((SELECT starts_at FROM games WHERE id=$1))`, [FRIDAY, PRIYA]);
  check(absent.rowCount === 1, "…and the host can see she said no");

  section("Saying no does NOT remove you from the crew");

  const stillRegular = await q(
    "SELECT 1 FROM game_regulars WHERE game_id=$1 AND profile_id=$2", [FRIDAY, PRIYA]);
  check(stillRegular.rowCount === 1,
    "Priya is STILL a regular — 'I can't make Friday' is not 'take me off the list forever'",
    "conflating those two is how apps quietly shed their most loyal users");

  section("Saying no opens the spot, and the right people hear about it");

  await q("DELETE FROM notifications");
  // Put Priya back in, then have her pull out — this time a spot genuinely opens.
  await q("DELETE FROM game_absences WHERE game_id=$1 AND profile_id=$2", [FRIDAY, PRIYA]);
  await asUser(PRIYA, "SELECT app.join_game($1)", [FRIDAY]);

  const told = await asUser(PRIYA, "SELECT app.cant_make_it($1) AS n", [FRIDAY]);
  check(Number(told.rows[0].n) > 0,
    `pulling out told ${told.rows[0].n} people nearby that a spot opened`);

  const notes = await q(
    `SELECT n.kind, p.display_name FROM notifications n
       JOIN profiles p ON p.id = n.profile_id ORDER BY p.display_name`);
  check(!notes.rows.some((r) => r.display_name === "Priya"),
    "…and Priya is not one of them — she is the reason the spot exists");
  console.log(`      told: ${notes.rows.map((r) => r.display_name).join(", ")}`);

  section("The weekly ask — asks each regular exactly once");

  await q("DELETE FROM notifications");
  await q("DELETE FROM game_players WHERE game_id=$1 AND profile_id IN ($2,$3)", [FRIDAY, PRIYA, DAN]);
  await q("DELETE FROM game_absences WHERE game_id=$1", [FRIDAY]);

  // The Friday game is 3 days out in the seed, so a 4-day window catches it.
  const first = await q("SELECT app.enqueue_weekly_prompts('4 days') AS n");
  check(Number(first.rows[0].n) === 2,
    `asked the 2 regulars who haven't answered (got ${first.rows[0].n})`,
    "Tom is still on the roster, so he must not be asked");

  const asked = await q(
    `SELECT p.display_name FROM notifications n JOIN profiles p ON p.id=n.profile_id
      WHERE n.kind='weekly_prompt' ORDER BY p.display_name`);
  console.log(`      asked: ${asked.rows.map((r) => r.display_name).join(", ")}`);
  check(!asked.rows.some((r) => r.display_name === "Tom"),
    "Tom is NOT asked — he already said yes by being on the roster");

  // Running the cron again must NOT double-ask. This is the property that
  // decides whether people trust the app or mute it.
  const second = await q("SELECT app.enqueue_weekly_prompts('4 days') AS n");
  check(Number(second.rows[0].n) === 0,
    "running the cron again asks NOBODY a second time",
    "double-asking is how you teach people to mute you");

  // And once someone ANSWERS, they fall out of the audience entirely.
  //
  // Note: we clear the notifications table here, which is the dedupe guard —
  // so Priya (who still hasn't answered) is legitimately asked again. That is
  // correct, and an earlier version of this test asserted it was a bug. What
  // must be true is narrower and more important: DAN, who has now answered,
  // is never asked again.
  await asUser(DAN, "SELECT app.join_game($1)", [FRIDAY]);
  await q("DELETE FROM notifications");
  await q("SELECT app.enqueue_weekly_prompts('4 days')");

  const nowAsked = await q(
    `SELECT p.display_name FROM notifications n JOIN profiles p ON p.id=n.profile_id
      WHERE n.kind='weekly_prompt'`);
  const asked2 = nowAsked.rows.map((r) => r.display_name);
  check(!asked2.includes("Dan"),
    "a regular who has now answered is dropped from the audience",
    `still asked: ${asked2.join(", ")}`);
  check(asked2.includes("Priya"),
    "…while the one who still hasn't answered is still asked");

  console.log("");
  if (failures.length) {
    console.log(`\x1b[31m✗ ${failures.length} FAILURE(S)\x1b[0m — ${pass} passed\n`);
    failures.forEach((f) => console.log(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ALL ${pass} WEEKLY-FIXTURE CHECKS PASSED\x1b[0m\n`);
})().catch((e) => { console.error("\nSUITE CRASHED\n", e); process.exit(1); });
