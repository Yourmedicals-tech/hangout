/**
 * types.ts — the shape of the world.
 *
 * THE DISCLOSURE LADDER, AS A TYPE.
 *
 * The database refuses to hand a non-member a venue name. Good. But the UI is
 * where a leak would actually be *seen*, and "remember not to render the venue
 * on the browse card" is exactly the kind of rule that survives three refactors
 * and then quietly dies.
 *
 * So we model it in the type system. `PublicGame` has no venue field. Not an
 * optional one, not a nullable one — no field. A component handed a PublicGame
 * *cannot* render a venue name, because there is nothing to render and the
 * compiler will say so. `MemberGame` has it, and you can only obtain one by
 * being in the game.
 *
 * Two layers of defence that fail in different ways: the database refuses to
 * send it, and the compiler refuses to draw it.
 */

export type SportId =
  | "badminton" | "cricket" | "football" | "padel"
  | "tennis" | "pickleball" | "squash" | "running";

/** A sport SUGGESTS. It never dictates. */
export interface Sport {
  id: SportId;
  name: string;
  emoji: string;
  /** What a game of this usually is. A default, never a rule. */
  typicalPlayers: number;
  /** Shortcuts, not constraints. Badminton: singles 2, doubles 4, rotating 6… */
  presets: Array<{ label: string; n: number }>;
  hasTeams: boolean;
  hasLevels: boolean;
  levelNames: string[];
  kit: string[];
  durationMin: number;
  isOutdoor: boolean;
  weatherDependent: boolean;
  season: string;
  guides: Array<{ title: string; by: string; len: string }>;
  launchThreshold: number;
  globallyLive: boolean;
}

export interface Area {
  id: string;      // "LE18"
  name: string;    // "Wigston"
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  areaId: string;
  pricePence: number;
  priceUnit: string;
  bookingUrl: string | null;
  /** Venues are public buildings. Exact distance is fine. */
  distanceMiles?: number;
}

/** Distance to a PERSON is always a band. Never a number. */
export type DistanceBand =
  | "under a mile" | "1-3 miles" | "3-5 miles"
  | "5-10 miles" | "10-25 miles" | "over 25 miles";

export interface Person {
  id: string;
  displayName: string;
  initials: string;
  isNewToArea: boolean;
  gamesAttended: number;
  gamesMissed: number;
  /** A band. There is deliberately no exact distance to a human anywhere. */
  distanceBand: DistanceBand;
}

/* ────────────────────────────────────────────────────────────────────────
   THE LADDER
   ──────────────────────────────────────────────────────────────────────── */

/**
 * What a stranger sees. Enough to decide; nothing that pins a human to a place.
 *
 * Note what is absent: no venueName, no court, no players[], no hostName.
 * They are not optional. They do not exist. A browse card literally cannot
 * render them.
 */
export interface PublicGame {
  readonly kind: "public";
  id: string;
  sportId: SportId;
  title: string;
  startsAt: string;
  durationMin: number;
  costPence: number;
  spotsNeeded: number;
  playerCount: number;
  spotsLeft: number;
  repeatsWeekly: boolean;
  approveRequired: boolean;
  beginnersWelcome: boolean;
  minLevel: string | null;
  splitTeams: boolean;
  note: string | null;
  isBooked: boolean;
  cancelled: boolean;

  /** Coarse only. "Wigston" — not "Active Wigston, Station Rd". */
  areaId: string;
  areaName: string;
  /** Distance to a public building is fine to state precisely. */
  distanceMiles: number;

  /** Can I trust this game, without knowing who is running it? */
  hostAttended: number;
  hostMissed: number;

  iAmIn: boolean;
  iHaveAsked: boolean;
  iAmWaiting: boolean;
  iAmHost: boolean;
}

/** What a member sees. Everything. You can only get one by being in the game. */
export interface MemberGame extends Omit<PublicGame, "kind"> {
  readonly kind: "member";
  venueName: string;
  venueAddress: string;
  venueBookingUrl: string | null;
  court: string | null;
  players: RosterEntry[];
  waitlist: RosterEntry[];
  asks: RosterEntry[];
  hostId: string;
  hostName: string;
  messages: GameMessage[];
}

export type Game = PublicGame | MemberGame;

/** Narrowing helper. The ONLY sanctioned way to get at a venue. */
export function isMember(g: Game): g is MemberGame {
  return g.kind === "member";
}

export interface RosterEntry {
  profileId: string;
  displayName: string;
  initials: string;
  level: string | null;
  gamesAttended: number;
  gamesMissed: number;
  paid: boolean;
  isHost: boolean;
}

export interface GameMessage {
  id: string;
  profileId: string | null;   // null = system ("Priya came off the waitlist")
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface Profile {
  id: string;
  displayName: string;
  initials: string;
  areaId: string;
  /** Hard-capped at 25 by the database. The client cannot raise it. */
  radiusMiles: number;
  isNewToArea: boolean;
  discoverable: boolean;
  notify: boolean;
  isAdult: boolean;
  isAdmin: boolean;
  gamesAttended: number;
  gamesMissed: number;
  sports: Array<{ sportId: SportId; level: string | null }>;
}

/** A sport waiting to open in an area. Demand first, then supply. */
export interface SportDemand {
  sportId: SportId;
  areaId: string;
  areaName: string;
  wantCount: number;
  threshold: number;
  isLive: boolean;
  stillNeeded: number;
  venuesHere: number;
}

/**
 * A recurring game you are a regular of and have NOT yet answered for this week.
 *
 * SILENCE IS NOT A YES. An unanswered regular is a question, never an
 * attendance. Treating silence as attendance is how a host turns up to a booked
 * court expecting six people and finds two.
 */
export interface WeeklyPrompt {
  gameId: string;
  sportId: SportId;
  title: string;
  startsAt: string;
  playerCount: number;
  spotsNeeded: number;
  spotsLeft: number;
  areaName: string;
  distanceMiles: number;
  /** how many of the crew have answered, either way */
  answered: number;
  regulars: number;
}

/** A request from a real person for a sport we haven't opened. It is not a
 *  silent counter: it lands in front of a human, and that human can answer. */
export interface SportRequest {
  id: string;
  personName: string;
  initials: string;
  sportId: SportId;
  areaId: string;
  createdAt: string;
  answered: boolean;
  /** demand in THEIR postcode — the only number that means anything */
  demandHere: number;
  threshold: number;
}

export type JoinOutcome =
  | "joined" | "asked" | "waitlisted" | "already_in"
  | "already_asked" | "cancelled" | "not_live";

/** Everything the UI can do. Implemented by SupabaseRepo and MockRepo alike. */
export interface Repo {
  me(): Promise<Profile | null>;
  signUp(input: { name: string; areaId: string; sports: SportId[] }): Promise<Profile>;

  sports(): Promise<Sport[]>;
  areas(): Promise<Area[]>;
  venuesFor(sportId: SportId): Promise<Venue[]>;

  gamesNearMe(): Promise<PublicGame[]>;
  /** Returns MemberGame if you are in it, PublicGame if you are not. */
  game(id: string): Promise<Game | null>;

  joinGame(id: string): Promise<JoinOutcome>;
  leaveGame(id: string): Promise<void>;
  acceptAsk(gameId: string, profileId: string): Promise<void>;
  postGame(input: PostGameInput): Promise<string>;
  sendMessage(gameId: string, body: string): Promise<void>;

  peopleNearMe(): Promise<Person[]>;

  /** "Your regulars — are you in this week?" */
  weeklyPrompts(): Promise<WeeklyPrompt[]>;
  /** Out this week. Does NOT remove you from the crew. */
  cantMakeIt(gameId: string): Promise<void>;
  becomeRegular(gameId: string): Promise<void>;

  demand(): Promise<SportDemand[]>;
  /** Admin only. Every "I want this" tap, oldest unanswered first. */
  sportRequests(): Promise<SportRequest[]>;
  replyToRequest(id: string, body: string): Promise<void>;
  /** true if YOU were the one who tipped the sport over its threshold. */
  wantSport(sportId: SportId): Promise<boolean>;

  setRadius(miles: number): Promise<void>;
}

export interface PostGameInput {
  sportId: SportId;
  venueId: string;
  title: string;
  startsAt: string;
  /** ANY number the host likes. Never forced to a sport's "typical". */
  spotsNeeded: number;
  costPence: number;
  court?: string;
  repeatsWeekly?: boolean;
  approveRequired?: boolean;
  beginnersWelcome?: boolean;
  minLevel?: string | null;
  splitTeams?: boolean;
  note?: string;
}
