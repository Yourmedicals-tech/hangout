#!/usr/bin/env node
/**
 * e2e.js — drive the real app in a real browser.
 *
 *   npx expo export --platform web --output-dir /tmp/hangout-web
 *   npx serve -l 7788 /tmp/hangout-web
 *   node apps/mobile/e2e.js
 *
 * Typecheck proves it compiles. Unit tests prove the logic. This proves the
 * thing a person actually touches — in particular that the disclosure ladder is
 * invisible on screen, not merely enforced in the database.
 *
 * Lives in the repo, not a temp dir. The previous versions of this were in
 * /tmp and got wiped, which is a fine way to lose your only end-to-end check.
 */
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.URL || "http://localhost:7788/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m, d) => { fails.push(m); console.log(`  \x1b[31m✗ ${m}\x1b[0m`); if (d) console.log("      " + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`);

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 1000 });

  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  let lastConfirm = "";
  page.on("dialog", async (d) => { lastConfirm = d.message(); await d.accept(); });

  const txt = () => page.evaluate(() => document.body.innerText);
  const tap = async (label) => {
    const done = await page.evaluate((l) => {
      const el = [...document.querySelectorAll("div,span")]
        .find((e) => e.innerText?.trim() === l && e.offsetParent !== null);
      if (!el) return false; el.click(); return true;
    }, label);
    await sleep(700);
    return done;
  };
  const tapId = async (id) => {
    const done = await page.evaluate((s) => {
      const el = document.querySelector(`[data-testid="${s}"]`);
      if (!el) return false; el.click(); return true;
    }, id);
    await sleep(800);
    return done;
  };
  const restart = async () => {
    await page.goto(URL, { waitUntil: "networkidle0" });
    await sleep(1400);
    await tap("I've already got one");
    await sleep(1200);
  };

  // ════════════════════════════════════════════════════════════
  section("Boots, and lands on a list of holes to fill");
  await page.goto(URL, { waitUntil: "networkidle0" }); await sleep(1400);
  let t = await txt();
  check(/one player short/i.test(t), "the thesis is on the welcome screen");
  await tap("I've already got one"); await sleep(1200);
  t = await txt();
  check(/Near you/i.test(t), "lands on Near you");
  check(/spot.? left/i.test(t), "shows a game that needs a player");

  // ════════════════════════════════════════════════════════════
  section("DISCLOSURE LADDER — a stranger cannot find the venue");
  check(!/Active Wigston/i.test(t), "no venue name on the browse card");
  check(/Wigston/.test(t), "…but the coarse district IS there");
  check(!/Court 3/i.test(t), "no court number");

  await tap("Friday doubles"); await sleep(900);
  t = await txt();
  check(/Shown once you're in/i.test(t), "says plainly what is held back");
  check(!/Active Wigston/i.test(t), "a non-member CANNOT see the venue");
  check(!/\bTom\b/.test(t) && !/\bPriya\b/.test(t), "…nor the players' names");
  check(/Host: 31 of 33/i.test(t), "but DOES see the host's record — trust without identity");
  check(/£5\.00/.test(t), "…and what it would cost them");

  section("…and joining reveals it, and only then");
  check(await tapId("game-join"), "tapped 'I'm in'");
  await sleep(1400);
  t = await txt();
  check(/Active Wigston/i.test(t), "member sees the exact venue");
  check(/Court 3/i.test(t), "…and the court");
  check(/Tom/.test(t), "…and the roster by name");

  // ════════════════════════════════════════════════════════════
  section("The standing fixture — silence is not a yes");
  await restart();
  t = await txt();
  check(/THIS WEEK/i.test(t), "'This week' sits at the top");
  check(/are you in\?/i.test(t), "…and asks the question");
  check(/Can't make it/i.test(t), "…with BOTH answers offered; no way to dismiss");
  check(await tapId("weekly-out"), "answered 'can't make it'");
  t = await txt();
  check(!/are you in\?/i.test(t), "the prompt disappears once answered");
  check(/NEEDS A PLAYER/i.test(t), "…and saying no opened the spot");

  // ════════════════════════════════════════════════════════════
  section("Density — a sport opens in a postcode, or not at all");
  await restart();
  await tap("Sports"); await sleep(900);
  t = await txt();
  check(/19 of 20/.test(t), "football sits at 19 of 20 in LE18");
  check(/One more person/i.test(t), "…and says so");
  check(/empty court/i.test(t), "explains why four padel players isn't a sport");

  section("Admin — ranked by best postcode, never the total");
  await tap("You"); await sleep(700);
  await tap("Requests and demand"); await sleep(900);
  t = await txt();
  check(/WHERE TO OPEN NEXT/i.test(t), "the demand board renders");
  check(/LE2/.test(t) && /LE3/.test(t), "broken down per postcode");
  check(t.indexOf("Football") < t.indexOf("Padel"),
    "FOOTBALL outranks PADEL — best area (19) beats padel's bigger total (25)",
    "ranking by total would put padel first, and open three empty courts");

  // ════════════════════════════════════════════════════════════
  section("Safety — App Store 1.2 and 5.1.1(v)");
  await restart();
  await tap("People"); await sleep(900);
  t = await txt();
  check(/Block/.test(t) && /Report/.test(t), "every profile has Block and Report");
  const before = await page.evaluate(() => document.body.innerText.split("Block").length - 1);

  const firstBlock = await page.evaluate(() =>
    document.querySelector('[data-testid^="block-"]')?.getAttribute("data-testid"));
  await tapId(firstBlock);
  await sleep(1000);
  check(/will not see each other anywhere/i.test(lastConfirm), "confirms before blocking");
  const after = await page.evaluate(() => document.body.innerText.split("Block").length - 1);
  check(after < before, `blocking actually removes them (${before} → ${after})`);

  await tap("You"); await sleep(800);
  t = await txt();
  check(/Delete my account/i.test(t), "in-app account deletion exists (5.1.1(v))");
  check(/Privacy policy/i.test(t), "…and a privacy policy link");
  lastConfirm = "";
  await tapId("delete-account");
  await sleep(1200);
  check(/cannot be undone/i.test(lastConfirm), "asks before deleting");
  t = await txt();
  check(/one player short/i.test(t), "…and deletion returns you to the welcome screen");

  // ════════════════════════════════════════════════════════════
  section("Console");
  check(errs.length === 0, "no JavaScript errors in any flow", errs[0]);

  await page.screenshot({ path: "/tmp/hangout-e2e.png" });
  await browser.close();

  console.log("");
  if (fails.length) {
    console.log(`\x1b[31m✗ ${fails.length} FAILURE(S)\x1b[0m — ${pass} passed\n`);
    fails.forEach((f) => console.log(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[32m✓ ALL ${pass} END-TO-END CHECKS PASSED\x1b[0m\n`);
})().catch((e) => { console.error("\nCRASHED\n", e); process.exit(1); });
