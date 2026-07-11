/**
 * domain.ts — the rules, as pure functions.
 *
 * Everything here is deterministic and dependency-free, which means it can be
 * unit-tested exhaustively without a database, a network, or a phone. If a rule
 * from the design conversations lives anywhere in the client, it lives here.
 */

import type {
  PublicGame, Game, Sport, RosterEntry, DistanceBand,
} from "./types";

export const MAX_RADIUS_MILES = 25;

/* ────────────────────────────────────────────────────────────────────────
   MONEY
   Always integer pence. Never floats.
   0.1 + 0.2 !== 0.3, and a court split that is a penny out every week is a
   thing a human WILL notice and WILL be annoyed about.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Split a cost N ways in whole pence, with no pennies lost or invented.
 * £20 between 3 is 666, 667, 667 — not 666.67 three times, which is £20.01.
 * The remainder goes to the earliest payers, deterministically.
 */
export function splitPence(totalPence: number, ways: number): number[] {
  if (ways <= 0) return [];
  if (totalPence <= 0) return Array(ways).fill(0);
  const base = Math.floor(totalPence / ways);
  const remainder = totalPence - base * ways;
  return Array.from({ length: ways }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** What THIS person pays. */
export function myShare(g: Pick<PublicGame, "costPence" | "playerCount" | "iAmIn">): number {
  if (g.costPence <= 0) return 0;
  // If I'm not in yet, the split is over everyone plus me — otherwise the
  // number on the browse card lies to me and I feel it when I get the bill.
  const ways = g.iAmIn ? Math.max(g.playerCount, 1) : g.playerCount + 1;
  return splitPence(g.costPence, ways)[0];
}

export function formatMoney(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** The host paid the venue up front. Who still owes them? */
export function hostIsOutOfPocket(roster: RosterEntry[], costPence: number): number {
  if (costPence <= 0) return 0;
  const shares = splitPence(costPence, roster.length);
  return roster.reduce((owed, p, i) => (p.paid ? owed : owed + shares[i]), 0);
}

/* ────────────────────────────────────────────────────────────────────────
   PLAYER COUNTS — nothing is fixed
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A sport suggests. The host decides.
 *
 * Badminton is doubles more often than not — and it is also singles, six
 * rotating, or eight across two courts. Squash is two, or three rotating.
 * Cricket is nets or a full XI. Any code that treats `typicalPlayers` as a
 * rule is code that will break on the next sport we add.
 */
export function isValidPlayerCount(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && n <= 50;
}

/** Presets are shortcuts. Ignoring them is always allowed. */
export function presetsFor(sport: Sport): Array<{ label: string; n: number }> {
  return sport.presets;
}

/**
 * Balance sides at ANY count, including odd ones.
 * Uneven is fine. Uneven is normal. A rule that demands even numbers is a rule
 * that stops seven people playing football.
 */
export function splitSides<T>(players: T[]): { a: T[]; b: T[] } {
  const a: T[] = [], b: T[] = [];
  players.forEach((p, i) => (i % 2 === 0 ? a : b).push(p));
  return { a, b };
}

/* ────────────────────────────────────────────────────────────────────────
   RELIABILITY — no-shows are the disease
   ──────────────────────────────────────────────────────────────────────── */

export interface Reliability {
  text: string;
  ratio: number | null;
  concerning: boolean;
}

/**
 * "Turned up to 12 of 13."
 *
 * This is not a vanity score. It is the thing that makes a stranger safe to
 * accept into your game — one person not turning up wastes seven people's
 * evening and a £20 court.
 *
 * A brand-new person is "New", never 0% — a zero would make everyone unjoinable
 * on their first day, which is precisely the person this whole app exists for.
 */
export function reliability(p: { gamesAttended: number; gamesMissed: number }): Reliability {
  const total = p.gamesAttended + p.gamesMissed;
  if (total === 0) return { text: "New", ratio: null, concerning: false };
  const ratio = p.gamesAttended / total;
  return {
    text: `${p.gamesAttended} of ${total}`,
    ratio,
    concerning: ratio < 0.85,
  };
}

/* ────────────────────────────────────────────────────────────────────────
   DISCOVERY
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The home screen is not a feed. It is a list of holes that need filling.
 * Games that need a player come first, soonest first. Everything else follows.
 */
export function sortForFeed(games: PublicGame[]): PublicGame[] {
  return [...games].sort((x, y) => {
    const xNeeds = x.spotsLeft > 0 && !x.iAmIn;
    const yNeeds = y.spotsLeft > 0 && !y.iAmIn;
    if (xNeeds !== yNeeds) return xNeeds ? -1 : 1;
    return Date.parse(x.startsAt) - Date.parse(y.startsAt);
  });
}

/** The client may ask for anything. It gets 25 miles, at most, forever. */
export function clampRadius(miles: number): number {
  if (!Number.isFinite(miles)) return 10;
  return Math.min(Math.max(Math.round(miles), 1), MAX_RADIUS_MILES);
}

/** Distance to a PERSON. Bands only — three exact distances are an address. */
export function bandFor(miles: number): DistanceBand {
  if (miles < 1) return "under a mile";
  if (miles < 3) return "1-3 miles";
  if (miles < 5) return "3-5 miles";
  if (miles < 10) return "5-10 miles";
  if (miles < 25) return "10-25 miles";
  return "over 25 miles";
}

/* ────────────────────────────────────────────────────────────────────────
   THE LADDER, RESTATED IN CODE
   ──────────────────────────────────────────────────────────────────────── */

/**
 * What a browse card is allowed to say about where a game is.
 *
 * Takes a `Game`, and if it is a PublicGame it is *structurally incapable* of
 * returning a venue name, because a PublicGame has no venue name to return.
 */
export function whereText(g: Game): string {
  if (g.kind === "member") return `${g.venueName}${g.court ? ` · ${g.court}` : ""}`;
  return `${g.distanceMiles} miles away · ${g.areaName}`;
}

/** What is being held back, so we can say so plainly. A locked door with no sign is just a wall. */
export function hiddenUntilYoureIn(g: Game): string[] {
  if (g.kind === "member") return [];
  return ["The exact venue and court", "Who's playing, by name", "The group chat"];
}

/** The one button. */
export function primaryAction(g: Game): "in" | "ask" | "waitlist" | "waiting" | "open" | "full" {
  if (g.iAmIn) return "open";
  if (g.iHaveAsked) return "waiting";
  if (g.iAmWaiting) return "waiting";
  if (g.spotsLeft > 0) return g.approveRequired ? "ask" : "in";
  return "waitlist";
}

/* ────────────────────────────────────────────────────────────────────────
   DENSITY — a sport opens in a postcode, or it does not open
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Rank sports by the BEST SINGLE AREA, never the total.
 *
 * "34 people in Leicester want padel" is a vanity number: if they are spread
 * across five postcodes, not one of them can get a game. The only figure that
 * means anything is the biggest pile in one place.
 */
export function rankByBestArea(
  demand: Array<{ sportId: string; areaId: string; wantCount: number; threshold: number }>,
): Array<{ sportId: string; bestArea: string; wantCount: number; threshold: number; ratio: number }> {
  const best = new Map<string, { areaId: string; wantCount: number; threshold: number }>();
  for (const d of demand) {
    const cur = best.get(d.sportId);
    if (!cur || d.wantCount > cur.wantCount) {
      best.set(d.sportId, { areaId: d.areaId, wantCount: d.wantCount, threshold: d.threshold });
    }
  }
  return [...best.entries()]
    .map(([sportId, b]) => ({
      sportId,
      bestArea: b.areaId,
      wantCount: b.wantCount,
      threshold: b.threshold,
      ratio: b.threshold > 0 ? b.wantCount / b.threshold : 0,
    }))
    .sort((x, y) => y.ratio - x.ratio);
}
