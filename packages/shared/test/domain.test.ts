/**
 * domain.test.ts — the rules, exhaustively.
 *
 * Run: npm -w @hangout/shared test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  splitPence, myShare, formatMoney, hostIsOutOfPocket,
  isValidPlayerCount, splitSides, reliability, sortForFeed,
  clampRadius, bandFor, whereText, hiddenUntilYoureIn, primaryAction,
  rankByBestArea, MAX_RADIUS_MILES,
} from "../src/domain.js";
import type { PublicGame, MemberGame, RosterEntry } from "../src/types.js";

const pub = (over: Partial<PublicGame> = {}): PublicGame => ({
  kind: "public",
  id: "g1", sportId: "badminton", title: "Friday doubles",
  startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
  durationMin: 60, costPence: 2000, spotsNeeded: 4, playerCount: 3, spotsLeft: 1,
  repeatsWeekly: true, approveRequired: false, beginnersWelcome: true,
  minLevel: null, splitTeams: false, note: null, isBooked: true, cancelled: false,
  areaId: "LE18", areaName: "Wigston", distanceMiles: 1.2,
  hostAttended: 31, hostMissed: 2,
  iAmIn: false, iHaveAsked: false, iAmWaiting: false, iAmHost: false,
  ...over,
});

describe("money — integer pence, never floats", () => {
  test("no pennies are lost or invented", () => {
    // £20 between 3 is the classic. 666.67 × 3 = £20.01 — a penny from nowhere.
    const s = splitPence(2000, 3);
    assert.deepEqual(s, [667, 667, 666]);
    assert.equal(s.reduce((a, b) => a + b, 0), 2000, "must sum EXACTLY to the total");
  });

  test("exhaustive: every split of every amount up to £50, 2..20 ways, always sums", () => {
    for (let total = 0; total <= 5000; total += 7) {
      for (let ways = 2; ways <= 20; ways++) {
        const s = splitPence(total, ways);
        assert.equal(s.length, ways);
        assert.equal(s.reduce((a, b) => a + b, 0), total,
          `£${total / 100} / ${ways} did not sum back`);
        assert.ok(Math.max(...s) - Math.min(...s) <= 1,
          "nobody may pay more than a penny more than anybody else");
      }
    }
  });

  test("free games are free", () => {
    assert.deepEqual(splitPence(0, 4), [0, 0, 0, 0]);
    assert.equal(myShare(pub({ costPence: 0 })), 0);
  });

  test("browsing shows what you WOULD pay, counting yourself in", () => {
    // 3 people, £20, one spot. If I join it is 4 ways = £5, not 3 ways = £6.67.
    // Showing £6.67 on the card and charging £5 later is a small lie that
    // people notice.
    assert.equal(myShare(pub({ costPence: 2000, playerCount: 3, iAmIn: false })), 500);
    assert.equal(formatMoney(myShare(pub({ iAmIn: false }))), "£5.00");
  });

  test("once you are in, the split is over the actual roster", () => {
    assert.equal(myShare(pub({ costPence: 2000, playerCount: 4, iAmIn: true })), 500);
  });

  test("the host is out of pocket for whoever has not paid", () => {
    const roster: RosterEntry[] = [
      { profileId: "1", displayName: "Tom", initials: "TM", level: null, gamesAttended: 31, gamesMissed: 2, paid: true, isHost: true },
      { profileId: "2", displayName: "Priya", initials: "PR", level: null, gamesAttended: 23, gamesMissed: 1, paid: false, isHost: false },
      { profileId: "3", displayName: "Dan", initials: "DK", level: null, gamesAttended: 9, gamesMissed: 4, paid: false, isHost: false },
      { profileId: "4", displayName: "Shiv", initials: "S", level: null, gamesAttended: 6, gamesMissed: 0, paid: false, isHost: false },
    ];
    // £20 four ways = £5 each. Tom paid. Three still owe him £15.
    assert.equal(hostIsOutOfPocket(roster, 2000), 1500);
    assert.equal(formatMoney(hostIsOutOfPocket(roster, 2000)), "£15.00");
  });
});

describe("player counts — NOTHING is fixed", () => {
  test("badminton is not always 4", () => {
    // singles, doubles, six rotating, eight across two courts — all badminton
    for (const n of [2, 4, 6, 8, 7, 11]) {
      assert.ok(isValidPlayerCount(n), `${n} must be a legal badminton game`);
    }
  });

  test("but a game still needs at least two people, and fewer than fifty", () => {
    assert.ok(!isValidPlayerCount(1), "a game of one is not a game");
    assert.ok(!isValidPlayerCount(0));
    assert.ok(!isValidPlayerCount(51));
    assert.ok(!isValidPlayerCount(4.5), "half a player is not a player");
  });

  test("sides balance at ANY count — uneven is fine, uneven is normal", () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"];
    const { a, b } = splitSides(seven);
    assert.equal(a.length + b.length, 7, "nobody is dropped");
    assert.ok(Math.abs(a.length - b.length) <= 1, "sides differ by at most one");
    assert.deepEqual(splitSides([]), { a: [], b: [] });
  });
});

describe("reliability — no-shows are the disease", () => {
  test("a brand-new person is New, never 0%", () => {
    // Scoring a newcomer at zero would make the very person this app exists for
    // unjoinable on their first day.
    const r = reliability({ gamesAttended: 0, gamesMissed: 0 });
    assert.equal(r.text, "New");
    assert.equal(r.concerning, false);
    assert.equal(r.ratio, null);
  });

  test("turned up to 12 of 13", () => {
    const r = reliability({ gamesAttended: 12, gamesMissed: 1 });
    assert.equal(r.text, "12 of 13");
    assert.equal(r.concerning, false);
  });

  test("a flaky player is flagged", () => {
    // Dan: 9 of 13. Worth knowing before you save him the last spot.
    const r = reliability({ gamesAttended: 9, gamesMissed: 4 });
    assert.equal(r.text, "9 of 13");
    assert.equal(r.concerning, true);
  });
});

describe("discovery", () => {
  test("the home screen is a list of holes, not a feed", () => {
    const soonButFull = pub({ id: "full", spotsLeft: 0, startsAt: new Date(Date.now() + 864e5).toISOString() });
    const laterNeedsOne = pub({ id: "needs", spotsLeft: 1, startsAt: new Date(Date.now() + 5 * 864e5).toISOString() });
    const [first] = sortForFeed([soonButFull, laterNeedsOne]);
    assert.equal(first.id, "needs", "a game that needs a player outranks a sooner game that doesn't");
  });

  test("the 25-mile cap cannot be argued with", () => {
    assert.equal(clampRadius(100), MAX_RADIUS_MILES);
    assert.equal(clampRadius(26), 25);
    assert.equal(clampRadius(-5), 1);
    assert.equal(clampRadius(NaN), 10);
    assert.equal(clampRadius(10), 10);
  });

  test("distance to a person is a band, never a number", () => {
    assert.equal(bandFor(0.8), "under a mile");
    assert.equal(bandFor(2.4), "1-3 miles");
    assert.equal(bandFor(4.6), "3-5 miles");
    assert.equal(bandFor(40), "over 25 miles");
    // Three exact distances triangulate to an address. Three bands do not.
    for (const m of [0.1, 0.9, 0.99]) assert.equal(bandFor(m), "under a mile");
  });
});

describe("the disclosure ladder, in the type system", () => {
  test("a PublicGame cannot say where it is", () => {
    const g = pub();
    assert.equal(whereText(g), "1.2 miles away · Wigston");
    assert.ok(!whereText(g).includes("Active Wigston"));
    // And the compiler agrees: `g.venueName` is not merely undefined, it does
    // not typecheck. That is checked by `npm run typecheck`, not at runtime.
    assert.ok(!("venueName" in g), "a PublicGame has no venueName field at all");
  });

  test("a MemberGame can", () => {
    const m: MemberGame = {
      ...pub({ iAmIn: true }), kind: "member",
      venueName: "Active Wigston", venueAddress: "Station Rd", venueBookingUrl: null,
      court: "Court 3", players: [], waitlist: [], asks: [],
      hostId: "h", hostName: "Tom", messages: [],
    };
    assert.equal(whereText(m), "Active Wigston · Court 3");
    assert.deepEqual(hiddenUntilYoureIn(m), [], "nothing is hidden from a member");
  });

  test("we say plainly what is held back — a locked door with no sign is a wall", () => {
    const hidden = hiddenUntilYoureIn(pub());
    assert.equal(hidden.length, 3);
    assert.ok(hidden.some((h) => /venue/i.test(h)));
    assert.ok(hidden.some((h) => /name/i.test(h)));
    assert.ok(hidden.some((h) => /chat/i.test(h)));
  });

  test("the button says the right thing", () => {
    assert.equal(primaryAction(pub()), "in");
    assert.equal(primaryAction(pub({ approveRequired: true })), "ask");
    assert.equal(primaryAction(pub({ spotsLeft: 0 })), "waitlist");
    assert.equal(primaryAction(pub({ iAmWaiting: true, spotsLeft: 0 })), "waiting");
    assert.equal(primaryAction(pub({ iHaveAsked: true })), "waiting");
    assert.equal(primaryAction(pub({ iAmIn: true })), "open");
  });
});

describe("density — a sport opens in a postcode, or it does not open", () => {
  test("ranks by the BEST AREA, not the total", () => {
    // Padel: 12+9+4 = 25 across three areas — a bigger TOTAL than football's 19.
    // But football has 19 in ONE postcode, and padel's biggest pile is 12.
    // Launching padel on the strength of "25 people want it in Leicester" gives
    // you three empty courts in three postcodes.
    const ranked = rankByBestArea([
      { sportId: "padel", areaId: "LE18", wantCount: 12, threshold: 20 },
      { sportId: "padel", areaId: "LE2", wantCount: 9, threshold: 20 },
      { sportId: "padel", areaId: "LE3", wantCount: 4, threshold: 20 },
      { sportId: "football", areaId: "LE18", wantCount: 19, threshold: 20 },
      { sportId: "football", areaId: "LE3", wantCount: 3, threshold: 20 },
    ]);
    assert.equal(ranked[0].sportId, "football", "football is closest to actually working");
    assert.equal(ranked[0].bestArea, "LE18");
    assert.equal(ranked[0].wantCount, 19);
    assert.equal(ranked[1].sportId, "padel");
    assert.equal(ranked[1].wantCount, 12, "padel is judged on its BEST 12, not its total 25");
  });
});
