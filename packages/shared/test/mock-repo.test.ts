/**
 * mock-repo.test.ts
 *
 * The mock exists so the app runs with zero credentials. That is only safe if
 * the mock is never MORE PERMISSIVE than Postgres — otherwise we build screens
 * against data the real database will refuse to send, and find out in
 * production, in front of users.
 *
 * So these tests are the same adversarial questions the SQL suite asks, put to
 * the mock. If Postgres says "no venue for you", the mock must say it too.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MockRepo } from "../src/mock-repo";
import { isMember } from "../src/types";
import { myShare, formatMoney, primaryAction, reliability } from "../src/domain";

const signedIn = () => new MockRepo({ signedIn: true });

describe("the disclosure ladder — the mock must be as strict as Postgres", () => {
  test("a non-member gets a PublicGame, which HAS NO VENUE", async () => {
    const r = signedIn();
    const g = await r.game("g1");           // Friday doubles — Shiv is not in it
    assert.ok(g);
    assert.equal(g.kind, "public");
    assert.equal(isMember(g), false);
    assert.ok(!("venueName" in g), "PublicGame must not carry a venue name");
    assert.ok(!("court" in g), "PublicGame must not carry a court");
    assert.ok(!("players" in g), "PublicGame must not carry a roster");
    assert.ok(!("messages" in g), "PublicGame must not carry the chat");
  });

  test("…but it tells them enough to decide", async () => {
    const r = signedIn();
    const g = (await r.game("g1"))!;
    assert.equal(g.playerCount, 3);
    assert.equal(g.spotsLeft, 1);
    assert.equal(g.areaName, "Wigston", "coarse district, not the building");
    assert.equal(g.distanceMiles, 1.2);
    assert.equal(g.costPence, 2000);
    // the host's record without the host's name — can I trust this game?
    assert.equal(g.hostAttended, 31);
    assert.equal(g.hostMissed, 2);
    assert.equal(reliability({ gamesAttended: g.hostAttended, gamesMissed: g.hostMissed }).text, "31 of 33");
    assert.ok(!("hostName" in g), "…and still no host NAME");
  });

  test("joining flips it to a MemberGame, and only then does the venue appear", async () => {
    const r = signedIn();
    assert.equal(await r.joinGame("g1"), "joined");
    const g = (await r.game("g1"))!;
    assert.equal(g.kind, "member");
    assert.ok(isMember(g));
    if (isMember(g)) {
      assert.equal(g.venueName, "Active Wigston");
      assert.equal(g.court, "Court 3");
      assert.equal(g.players.length, 4);
      assert.ok(g.players.some((p) => p.displayName === "You"));
      assert.ok(g.messages.length > 0, "the group chat is now readable");
    }
  });

  test("a non-member cannot post to a group chat", async () => {
    const r = signedIn();
    await assert.rejects(() => r.sendMessage("g1", "hello"), /only members/);
  });
});

describe("the last spot", () => {
  test("a full game waitlists you rather than rejecting you", async () => {
    const r = signedIn();
    // g2 (Tuesday ladder) is 6/6 and approval-required
    const before = (await r.game("g2"))!;
    assert.equal(before.spotsLeft, 0);
    assert.equal(await r.joinGame("g2"), "waitlisted",
      "full beats approval — you cannot ask to join a game with no room");
    const after = (await r.game("g2"))!;
    assert.equal(after.iAmWaiting, true);
  });

  test("dropping out promotes the top of the waitlist — nobody has to shout", async () => {
    const r = signedIn();
    await r.joinGame("g1");                       // 4/4, I am in
    assert.equal((await r.game("g1"))!.spotsLeft, 0);
    await r.leaveGame("g1");                      // I drop out
    const g = (await r.game("g1"))!;
    assert.equal(g.playerCount, 3, "the spot is open again");
    assert.equal(g.kind, "public", "and I can no longer see the venue");
  });

  test("tapping twice is a double-tap, not an error", async () => {
    const r = signedIn();
    assert.equal(await r.joinGame("g1"), "joined");
    assert.equal(await r.joinGame("g1"), "already_in");
  });
});

describe("the host approves — never the admin", () => {
  test("an approval game returns 'asked', and the venue stays hidden", async () => {
    const r = signedIn();
    // g4: Thursday hardball nets, approval required, 3 of 6
    assert.equal(await r.joinGame("g4"), "asked");
    const g = (await r.game("g4"))!;
    assert.equal(g.kind, "public", "asking is not joining — no venue yet");
    assert.equal(g.iHaveAsked, true);
    assert.equal(primaryAction(g), "waiting");
  });
});

describe("nothing is fixed", () => {
  test("badminton exists at two different shapes in the same feed", async () => {
    const r = signedIn();
    const games = await r.gamesNearMe();
    const badminton = games.filter((g) => g.sportId === "badminton");
    const shapes = new Set(badminton.map((g) => g.spotsNeeded));
    assert.ok(shapes.has(4) && shapes.has(6),
      `badminton is 4 AND 6 in the same feed — got ${[...shapes]}`);
  });

  test("a host can post a 7-player badminton game and nothing objects", async () => {
    const r = signedIn();
    const id = await r.postGame({
      sportId: "badminton", venueId: "v1", title: "Seven of us, why not",
      startsAt: new Date(Date.now() + 864e5).toISOString(),
      spotsNeeded: 7,           // not 2, not 4, not 6, not a preset
      costPence: 2000,
    });
    const g = (await r.game(id))!;
    assert.equal(g.spotsNeeded, 7);
  });

  test("cost follows the venue, and stays editable", async () => {
    const r = signedIn();
    // Evington Park (free) — but the host can still charge for a new ball
    const id = await r.postGame({
      sportId: "cricket", venueId: "v4", title: "Park game, chipping in for a ball",
      startsAt: new Date(Date.now() + 864e5).toISOString(),
      spotsNeeded: 10, costPence: 500,
    });
    assert.equal((await r.game(id))!.costPence, 500);
  });
});

describe("money on the browse card must not lie", () => {
  test("shows what you WOULD pay, counting yourself in", async () => {
    const r = signedIn();
    const g = (await r.game("g1"))!;           // £20, 3 players, I'm not in
    assert.equal(formatMoney(myShare(g)), "£5.00",
      "£20 among the 3 of them plus me = £5, not £6.67");
    await r.joinGame("g1");
    const after = (await r.game("g1"))!;
    assert.equal(formatMoney(myShare(after)), "£5.00", "…and it is still £5 once I am in");
  });
});

describe("privacy", () => {
  test("people near me come back as BANDS, with no exact distance anywhere", async () => {
    const r = signedIn();
    const people = await r.peopleNearMe();
    assert.ok(people.length > 0);
    for (const p of people) {
      assert.ok(!/\d+\.\d+/.test(p.distanceBand), `"${p.distanceBand}" looks like a number`);
      assert.ok(!("distanceMiles" in p), "no exact distance to a human, anywhere");
    }
    assert.ok(people.some((p) => p.distanceBand === "under a mile"));
  });

  test("the 25-mile cap cannot be exceeded, however nicely you ask", async () => {
    const r = signedIn();
    await r.setRadius(100);
    const me = await r.me();
    assert.equal(me!.radiusMiles, 25);
  });
});

describe("density — the sport that opens in front of you", () => {
  test("football is one person short in LE18", async () => {
    const r = signedIn();
    const d = (await r.demand()).find((x) => x.sportId === "football" && x.areaId === "LE18")!;
    assert.equal(d.wantCount, 19);
    assert.equal(d.threshold, 20);
    assert.equal(d.stillNeeded, 1);
    assert.equal(d.isLive, false);
  });

  test("wanting it tips it over — and the first game appears", async () => {
    const r = signedIn();
    const before = await r.gamesNearMe();
    assert.equal(before.filter((g) => g.sportId === "football").length, 0,
      "no football games while football is not live");

    const tipped = await r.wantSport("football");
    assert.equal(tipped, true, "you were the twentieth person");

    const d = (await r.demand()).find((x) => x.sportId === "football" && x.areaId === "LE18")!;
    assert.equal(d.isLive, true);

    const after = await r.gamesNearMe();
    assert.ok(after.some((g) => g.sportId === "football"),
      "a first football game is seeded the moment the sport opens");
  });

  test("padel does NOT tip over — it is eight people short", async () => {
    const r = signedIn();
    assert.equal(await r.wantSport("padel"), false);
    const d = (await r.demand()).find((x) => x.sportId === "padel" && x.areaId === "LE18")!;
    assert.equal(d.wantCount, 13);
    assert.equal(d.isLive, false, "13 of 20 is not a market, it is an empty court");
  });

  test("you cannot post a game in a sport that has not opened here", async () => {
    const r = signedIn();
    await assert.rejects(
      () => r.postGame({
        sportId: "padel", venueId: "v9", title: "Padel anyone",
        startsAt: new Date(Date.now() + 864e5).toISOString(),
        spotsNeeded: 4, costPence: 3200,
      }),
      /not open here/);
  });
});
