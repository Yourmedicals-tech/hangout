/**
 * mock-repo.ts — the app runs today, with no accounts and no keys.
 *
 * This is not a stub that throws "not implemented". It is a complete, in-memory
 * implementation of the same `Repo` interface the real Supabase client will
 * satisfy — including the disclosure ladder, the last-spot race, the waitlist
 * promotion and the density thresholds.
 *
 * Two reasons that matters:
 *
 *  1. Shiv can run the app on his phone tonight without creating a single
 *     account or pasting a single API key.
 *  2. Every screen is developed against the same interface the real backend
 *     implements, so swapping MockRepo for SupabaseRepo is a one-line change in
 *     one file — not a rewrite of the UI.
 *
 * The ladder is re-implemented here on purpose. The mock must not be MORE
 * permissive than Postgres, or we would develop screens against data the real
 * database will refuse to send, and only find out in production.
 */

import type {
  Repo, Profile, Sport, SportId, Area, Venue, Person,
  PublicGame, MemberGame, Game, JoinOutcome, PostGameInput,
  SportDemand, RosterEntry, GameMessage, WeeklyPrompt, SportRequest,
} from "./types";
import { bandFor, clampRadius, splitSides, MAX_RADIUS_MILES } from "./domain";

interface MockPerson {
  id: string; name: string; initials: string; areaId: string;
  distanceMiles: number; sports: Array<{ sportId: SportId; level: string | null }>;
  attended: number; missed: number; isNew: boolean;
}

interface MockGame {
  id: string; sportId: SportId; hostId: string;
  venueId: string; court: string | null;
  title: string; startsAt: string; durationMin: number;
  costPence: number; spotsNeeded: number;
  repeatsWeekly: boolean; approveRequired: boolean; beginnersWelcome: boolean;
  minLevel: string | null; splitTeams: boolean; note: string | null;
  isBooked: boolean; hostPaidUpfront: boolean; cancelled: boolean;
  players: string[]; waitlist: string[]; asks: string[]; regulars: string[];
  paid: string[];
  messages: Array<{ id: string; profileId: string | null; body: string; createdAt: string }>;
}

const ME = "me";
const days = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

export class MockRepo implements Repo {
  private me_: Profile | null = null;
  private people: MockPerson[] = [];
  private games: MockGame[] = [];
  private venues: Venue[] = [];
  private sports_: Sport[] = [];
  private areas_: Area[] = [];
  private demand_: SportDemand[] = [];
  private unlocked = new Set<SportId>();
  private wanted = new Set<SportId>();
  /** games I have said I cannot make this week */
  private absent = new Set<string>();
  private requests_: SportRequest[] = [];
  /** symmetric in effect — one-way blocking leaves them still watching you */
  private blocked = new Set<string>();

  constructor(opts: { signedIn?: boolean } = {}) {
    this.seed();
    if (opts.signedIn) this.signInAsShiv();
  }

  /* ─────────────────────────────────────────────── the ladder */

  /** What a stranger is allowed to know. Mirrors games_public exactly. */
  private toPublic(g: MockGame): PublicGame {
    const venue = this.venues.find((v) => v.id === g.venueId)!;
    const host = this.people.find((p) => p.id === g.hostId);
    const inIt = g.players.includes(ME);
    return {
      kind: "public",
      id: g.id, sportId: g.sportId, title: g.title, startsAt: g.startsAt,
      durationMin: g.durationMin, costPence: g.costPence,
      spotsNeeded: g.spotsNeeded, playerCount: g.players.length,
      spotsLeft: Math.max(g.spotsNeeded - g.players.length, 0),
      repeatsWeekly: g.repeatsWeekly, approveRequired: g.approveRequired,
      beginnersWelcome: g.beginnersWelcome, minLevel: g.minLevel,
      splitTeams: g.splitTeams, note: g.note,
      isBooked: g.isBooked, cancelled: g.cancelled,
      // coarse only — never the building
      areaId: venue.areaId,
      areaName: this.areas_.find((a) => a.id === venue.areaId)?.name ?? venue.areaId,
      distanceMiles: venue.distanceMiles ?? 0,
      // trust without identity
      hostAttended: host?.attended ?? (g.hostId === ME ? (this.me_?.gamesAttended ?? 0) : 0),
      hostMissed: host?.missed ?? (g.hostId === ME ? (this.me_?.gamesMissed ?? 0) : 0),
      iAmIn: inIt, iHaveAsked: g.asks.includes(ME),
      iAmWaiting: g.waitlist.includes(ME), iAmHost: g.hostId === ME,
    };
  }

  /** Everything — but ONLY if you are in it. Mirrors the RLS on `games`. */
  private toMember(g: MockGame): MemberGame {
    const venue = this.venues.find((v) => v.id === g.venueId)!;
    const roster = (ids: string[]): RosterEntry[] =>
      ids.map((id) => {
        const p = this.person(id);
        return {
          profileId: id,
          displayName: id === ME ? "You" : p.name,
          initials: p.initials,
          level: p.sports.find((s) => s.sportId === g.sportId)?.level ?? null,
          gamesAttended: p.attended, gamesMissed: p.missed,
          paid: g.paid.includes(id), isHost: g.hostId === id,
        };
      });
    const msgs: GameMessage[] = g.messages.map((m) => ({
      id: m.id, profileId: m.profileId,
      authorName: m.profileId ? (m.profileId === ME ? "You" : this.person(m.profileId).name) : null,
      body: m.body, createdAt: m.createdAt,
    }));
    return {
      ...this.toPublic(g), kind: "member",
      venueName: venue.name, venueAddress: venue.address,
      venueBookingUrl: venue.bookingUrl, court: g.court,
      players: roster(g.players), waitlist: roster(g.waitlist), asks: roster(g.asks),
      hostId: g.hostId,
      hostName: g.hostId === ME ? "You" : this.person(g.hostId).name,
      messages: msgs,
    };
  }

  private person(id: string): MockPerson {
    if (id === ME) {
      return {
        id: ME, name: this.me_?.displayName ?? "You", initials: this.me_?.initials ?? "Y",
        areaId: this.me_?.areaId ?? "LE18", distanceMiles: 0,
        sports: this.me_?.sports ?? [], attended: this.me_?.gamesAttended ?? 0,
        missed: this.me_?.gamesMissed ?? 0, isNew: this.me_?.isNewToArea ?? false,
      };
    }
    return this.people.find((p) => p.id === id)!;
  }

  private isLive(s: SportId): boolean {
    const sport = this.sports_.find((x) => x.id === s);
    return !!sport?.globallyLive || this.unlocked.has(s);
  }

  /* ─────────────────────────────────────────────── Repo */

  async me() { return this.me_; }

  async signUp(input: { name: string; areaId: string; sports: SportId[] }): Promise<Profile> {
    const initials = input.name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    this.me_ = {
      id: ME, displayName: input.name, initials,
      areaId: input.areaId, radiusMiles: 10,
      isNewToArea: false, discoverable: true, notify: true,
      isAdult: true, isAdmin: true,   // prototype: you are the admin
      gamesAttended: 0, gamesMissed: 0,
      sports: input.sports.map((s) => ({ sportId: s, level: null })),
    };
    // Picking a sport that isn't open counts you toward its threshold — and if
    // you tip it over, it opens then and there.
    for (const s of input.sports) if (!this.isLive(s)) this.want(s);

    // PROTOTYPE SEEDING, and it is a lie — a genuinely new user has no standing
    // fixtures and would see no weekly prompt, which is correct. But there is no
    // "next week" in a demo, so we hand the new account one existing crew
    // membership. Otherwise the single best feature in the app is invisible
    // until a week has passed, which is not a demo, it's a wait.
    //
    // In SupabaseRepo this does not exist: you become a regular by joining a
    // recurring game and saying "ask me every week".
    const recurring = this.games.find(
      (g) => g.repeatsWeekly && input.sports.includes(g.sportId) && !g.players.includes(ME),
    );
    if (recurring && !recurring.regulars.includes(ME)) recurring.regulars.push(ME);

    return this.me_;
  }

  private signInAsShiv() {
    this.me_ = {
      id: ME, displayName: "Shiv", initials: "S", areaId: "LE18", radiusMiles: 10,
      isNewToArea: false, discoverable: true, notify: true, isAdult: true, isAdmin: true,
      gamesAttended: 6, gamesMissed: 0,
      sports: [{ sportId: "badminton", level: "Improver" }, { sportId: "cricket", level: null }],
    };
    // Shiv is a regular of the Friday badminton but has not answered for this
    // week -- so the "are you in?" prompt has something real to ask him.
    const friday = this.games.find((g) => g.id === "g1");
    if (friday && !friday.regulars.includes(ME)) friday.regulars.push(ME);
  }

  async sports() { return this.sports_; }
  async areas() { return this.areas_; }
  async venuesFor(sportId: SportId) {
    return this.venues
      .filter((v) => this.venueSports[v.id]?.includes(sportId))
      .sort((a, b) => (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0));
  }

  async gamesNearMe(): Promise<PublicGame[]> {
    const me = this.me_;
    if (!me) return [];
    const radius = clampRadius(me.radiusMiles);   // 25-mile cap, always
    const mySports = new Set(me.sports.map((s) => s.sportId));
    return this.games
      .filter((g) => mySports.has(g.sportId))
      .filter((g) => !this.blocked.has(g.hostId))     // blocked host = no game
      .filter((g) => this.isLive(g.sportId))
      .filter((g) => !g.cancelled)
      .filter((g) => (this.venues.find((v) => v.id === g.venueId)?.distanceMiles ?? 99) <= radius)
      .map((g) => this.toPublic(g));
  }

  async game(id: string): Promise<Game | null> {
    const g = this.games.find((x) => x.id === id);
    if (!g) return null;
    // THE LADDER. Not a filter applied to a full object — a different object.
    return g.players.includes(ME) ? this.toMember(g) : this.toPublic(g);
  }

  /**
   * The last spot.
   *
   * JS is single-threaded, so there is no true race to lose here — but the
   * ORDER of checks is deliberately identical to app.join_game() in Postgres,
   * so the mock and the real backend can never disagree about who got in.
   */
  async joinGame(id: string): Promise<JoinOutcome> {
    const g = this.games.find((x) => x.id === id);
    if (!g) throw new Error("no such game");
    if (!this.me_?.isAdult) throw new Error("must be 18 or over");
    if (this.blocked.has(g.hostId)) throw new Error("unavailable");
    if (g.cancelled) return "cancelled";
    if (!this.isLive(g.sportId)) return "not_live";
    if (g.players.includes(ME)) return "already_in";

    if (g.players.length >= g.spotsNeeded) {
      if (!g.waitlist.includes(ME)) g.waitlist.push(ME);
      return "waitlisted";
    }
    if (g.approveRequired) {
      if (g.asks.includes(ME)) return "already_asked";
      g.asks.push(ME);
      return "asked";
    }
    g.players.push(ME);
    g.waitlist = g.waitlist.filter((x) => x !== ME);
    this.absent.delete(id);              // saying yes overrides an earlier no
    this.sys(g, `${this.me_.displayName} is in`);
    return "joined";
  }

  async leaveGame(id: string) {
    const g = this.games.find((x) => x.id === id);
    if (!g) return;
    g.players = g.players.filter((x) => x !== ME);
    g.paid = g.paid.filter((x) => x !== ME);
    this.sys(g, `${this.me_?.displayName} dropped out`);
    // the spot does not sit empty and nobody has to shout
    const next = g.waitlist.shift();
    if (next) {
      g.players.push(next);
      this.sys(g, `${this.person(next).name} came off the waitlist`);
    }
  }

  async acceptAsk(gameId: string, profileId: string) {
    const g = this.games.find((x) => x.id === gameId);
    if (!g || g.hostId !== ME) throw new Error("only the host decides who joins");
    g.asks = g.asks.filter((x) => x !== profileId);
    if (g.players.length < g.spotsNeeded) {
      g.players.push(profileId);
      this.sys(g, `${this.person(profileId).name} was let in`);
    }
  }

  /**
   * The standing fixture.
   *
   * A prompt appears only while the question is genuinely open: you are a
   * regular, the game hasn't happened, and you have said NEITHER yes nor no.
   * It disappears the instant you answer — either way. A prompt that lingers
   * after you've answered is a prompt people learn to ignore, and then the
   * whole mechanism is dead.
   */
  async weeklyPrompts(): Promise<WeeklyPrompt[]> {
    return this.games
      .filter((g) => g.repeatsWeekly && !g.cancelled)
      .filter((g) => g.regulars.includes(ME))
      .filter((g) => !g.players.includes(ME))       // hasn't said yes
      .filter((g) => !this.absent.has(g.id))        // ...nor no
      .map((g) => {
        const venue = this.venues.find((v) => v.id === g.venueId)!;
        const answered = g.regulars.filter(
          (r) => g.players.includes(r) || (r === ME && this.absent.has(g.id)),
        ).length;
        return {
          gameId: g.id, sportId: g.sportId, title: g.title, startsAt: g.startsAt,
          playerCount: g.players.length, spotsNeeded: g.spotsNeeded,
          spotsLeft: Math.max(g.spotsNeeded - g.players.length, 0),
          areaName: this.areas_.find((a) => a.id === venue.areaId)?.name ?? venue.areaId,
          distanceMiles: venue.distanceMiles ?? 0,
          answered, regulars: g.regulars.length,
        };
      });
  }

  /**
   * "Can't make it this week."
   *
   * Note what this does NOT do: it does not remove you as a regular. You are
   * still in the crew — you are just out this Friday. Conflating "I can't make
   * Friday" with "take me off the list forever" is how apps quietly shed their
   * most loyal users.
   */
  async cantMakeIt(gameId: string): Promise<void> {
    const g = this.games.find((x) => x.id === gameId);
    if (!g) return;
    this.absent.add(gameId);
    const wasIn = g.players.includes(ME);
    g.players = g.players.filter((p) => p !== ME);
    if (!wasIn) return;                             // never said yes; no spot opened
    this.sys(g, `${this.me_?.displayName} can't make it this week`);
    // The waitlist gets first refusal, exactly as in leave_game.
    const next = g.waitlist.shift();
    if (next) {
      g.players.push(next);
      this.sys(g, `${this.person(next).name} came off the waitlist`);
    }
  }

  async becomeRegular(gameId: string): Promise<void> {
    const g = this.games.find((x) => x.id === gameId);
    if (!g) throw new Error("no such game");
    if (!g.players.includes(ME)) {
      throw new Error("you must be in a game before you can be a regular of it");
    }
    if (!g.regulars.includes(ME)) g.regulars.push(ME);
  }

  async postGame(i: PostGameInput): Promise<string> {
    if (!this.isLive(i.sportId)) throw new Error(`${i.sportId} is not open here yet`);
    const id = `u${this.games.length + 1}`;
    this.games.unshift({
      id, sportId: i.sportId, hostId: ME, venueId: i.venueId, court: i.court ?? null,
      title: i.title, startsAt: i.startsAt,
      durationMin: this.sports_.find((s) => s.id === i.sportId)?.durationMin ?? 60,
      costPence: i.costPence,
      spotsNeeded: i.spotsNeeded,      // ANY number. Never forced to "typical".
      repeatsWeekly: !!i.repeatsWeekly, approveRequired: !!i.approveRequired,
      beginnersWelcome: i.beginnersWelcome ?? true, minLevel: i.minLevel ?? null,
      splitTeams: !!i.splitTeams, note: i.note ?? null,
      isBooked: false, hostPaidUpfront: false, cancelled: false,
      players: [ME], waitlist: [], asks: [], regulars: i.repeatsWeekly ? [ME] : [],
      paid: [], messages: [],
    });
    return id;
  }

  async sendMessage(gameId: string, body: string) {
    const g = this.games.find((x) => x.id === gameId);
    if (!g) return;
    if (!g.players.includes(ME)) throw new Error("only members can post to the group");
    g.messages.push({ id: `m${g.messages.length}`, profileId: ME, body, createdAt: new Date().toISOString() });
  }

  async peopleNearMe(): Promise<Person[]> {
    const me = this.me_;
    if (!me) return [];
    const radius = clampRadius(me.radiusMiles);
    const mySports = new Set(me.sports.map((s) => s.sportId).filter((s) => this.isLive(s)));
    return this.people
      .filter((p) => !this.blocked.has(p.id))         // blocked = invisible
      .filter((p) => p.sports.some((s) => mySports.has(s.sportId)))
      .filter((p) => p.distanceMiles <= radius)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .map((p) => ({
        id: p.id, displayName: p.name, initials: p.initials,
        isNewToArea: p.isNew, gamesAttended: p.attended, gamesMissed: p.missed,
        // BAND. The exact distance never leaves this function.
        distanceBand: bandFor(p.distanceMiles),
      }));
  }

  async demand(): Promise<SportDemand[]> {
    return this.demand_.map((d) => ({
      ...d,
      isLive: this.isLive(d.sportId),
      stillNeeded: Math.max(d.threshold - d.wantCount, 0),
    }));
  }

  async wantSport(sportId: SportId): Promise<boolean> { return this.want(sportId); }

  /**
   * The admin inbox. Every "I want this" tap is not a silent counter — it puts
   * a human request in front of a human, who can answer. In the early days the
   * founder IS the growth engine, and this is the tool.
   */
  /** A block that works on one screen is not a block. */
  async blockUser(profileId: string): Promise<void> {
    this.blocked.add(profileId);
    // and it has to actually separate you: leave anything they host.
    for (const g of this.games) {
      if (g.hostId === profileId) g.players = g.players.filter((p) => p !== ME);
    }
  }

  async reportUser(profileId: string, _reason: string, _detail?: string): Promise<void> {
    // Reporting blocks too. Nobody reports a person and then wants to keep
    // seeing them for the 24 hours it takes us to read it.
    await this.blockUser(profileId);
  }

  async deleteMyAccount(): Promise<void> {
    this.games = this.games.filter((g) => g.hostId !== ME);
    for (const g of this.games) {
      g.players = g.players.filter((p) => p !== ME);
      g.regulars = g.regulars.filter((p) => p !== ME);
      g.waitlist = g.waitlist.filter((p) => p !== ME);
    }
    this.me_ = null;
  }

  async sportRequests(): Promise<SportRequest[]> {
    return [...this.requests_].sort(
      (a, b) => Number(a.answered) - Number(b.answered)   // unanswered first
        || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }

  async replyToRequest(id: string, _body: string): Promise<void> {
    const r = this.requests_.find((x) => x.id === id);
    if (r) r.answered = true;
  }

  private want(sportId: SportId): boolean {
    if (this.wanted.has(sportId)) return false;
    this.wanted.add(sportId);
    const myArea = this.me_?.areaId ?? "LE18";
    // The tap files a REQUEST, not just a counter. A real person sees it.
    const row = this.demand_.find((d) => d.sportId === sportId && d.areaId === myArea);
    this.requests_.unshift({
      id: `r${this.requests_.length + 1}`,
      personName: this.me_?.displayName ?? "You",
      initials: this.me_?.initials ?? "Y",
      sportId, areaId: myArea,
      createdAt: new Date().toISOString(),
      answered: false,
      demandHere: (row?.wantCount ?? 0) + 1,
      threshold: row?.threshold ?? 20,
    });
    if (!row) return false;
    row.wantCount += 1;
    if (this.me_ && !this.me_.sports.some((s) => s.sportId === sportId)) {
      this.me_.sports.push({ sportId, level: null });
    }
    const tipped = !this.isLive(sportId) && row.wantCount >= row.threshold;
    if (tipped) {
      this.unlocked.add(sportId);
      this.seedFirstGameFor(sportId);
    }
    return tipped;
  }

  async setRadius(miles: number) {
    if (this.me_) this.me_.radiusMiles = clampRadius(miles);   // cannot exceed 25
  }

  /* ─────────────────────────────────────────────── plumbing */

  private sys(g: MockGame, body: string) {
    g.messages.push({ id: `m${g.messages.length}`, profileId: null, body, createdAt: new Date().toISOString() });
  }

  private venueSports: Record<string, SportId[]> = {};

  private seedFirstGameFor(sportId: SportId) {
    const venue = this.venues.find((v) => this.venueSports[v.id]?.includes(sportId));
    if (!venue) return;
    const sport = this.sports_.find((s) => s.id === sportId)!;
    const starters = this.people.filter((p) => p.sports.some((s) => s.sportId === sportId)).slice(0, 3);
    const host = starters[0] ?? this.people[0];
    this.games.unshift({
      id: `seed-${sportId}`, sportId, hostId: host.id, venueId: venue.id, court: "Pitch 2",
      title: sportId === "football" ? "Sunday five-a-side" : `First ${sport.name.toLowerCase()} session`,
      startsAt: days(5), durationMin: sport.durationMin,
      costPence: venue.pricePence, spotsNeeded: sport.typicalPlayers,
      repeatsWeekly: true, approveRequired: false, beginnersWelcome: true,
      minLevel: null, splitTeams: sport.hasTeams, note:
        `The first one since ${sport.name.toLowerCase()} opened here. Everyone's new to it — come along.`,
      isBooked: false, hostPaidUpfront: false, cancelled: false,
      players: starters.map((p) => p.id), waitlist: [], asks: [],
      regulars: starters.map((p) => p.id), paid: [],
      messages: [{ id: "m0", profileId: null, body: `${sport.name} went live near you`, createdAt: new Date().toISOString() }],
    });
  }

  private seed() {
    this.areas_ = [
      { id: "LE18", name: "Wigston" }, { id: "LE2", name: "Leicester South" },
      { id: "LE3", name: "Leicester West" }, { id: "LE5", name: "Leicester East" },
    ];

    const S = (o: Partial<Sport> & Pick<Sport, "id" | "name" | "emoji" | "typicalPlayers" | "presets">): Sport => ({
      hasTeams: false, hasLevels: false, levelNames: [], kit: [], durationMin: 60,
      isOutdoor: false, weatherDependent: false, season: "year-round", guides: [],
      launchThreshold: 20, globallyLive: false, ...o,
    });

    this.sports_ = [
      S({ id: "badminton", name: "Badminton", emoji: "🏸", typicalPlayers: 4, globallyLive: true,
          hasLevels: true, levelNames: ["Beginner", "Improver", "Intermediate", "Advanced"],
          kit: ["Racket — spares usually available", "Non-marking indoor trainers"],
          presets: [{ label: "Singles", n: 2 }, { label: "Doubles", n: 4 }, { label: "Rotating", n: 6 }, { label: "Two courts", n: 8 }] }),
      S({ id: "cricket", name: "Cricket", emoji: "🏏", typicalPlayers: 12, globallyLive: true,
          hasTeams: true, isOutdoor: true, weatherDependent: true, season: "summer", durationMin: 150,
          kit: ["Bat and ball provided", "Trainers"],
          presets: [{ label: "Nets", n: 6 }, { label: "Six a side", n: 12 }, { label: "Eight a side", n: 16 }, { label: "Full XI", n: 22 }] }),
      S({ id: "football", name: "Football", emoji: "⚽", typicalPlayers: 10, hasTeams: true,
          isOutdoor: true, weatherDependent: true, kit: ["Boots or astro trainers"],
          presets: [{ label: "5 a side", n: 10 }, { label: "6 a side", n: 12 }, { label: "7 a side", n: 14 }, { label: "11 a side", n: 22 }] }),
      S({ id: "padel", name: "Padel", emoji: "🎾", typicalPlayers: 4, hasLevels: true, durationMin: 90,
          levelNames: ["Beginner", "Improver", "Intermediate", "Advanced"], isOutdoor: true,
          kit: ["Padel bat — courts hire them out"],
          presets: [{ label: "Singles", n: 2 }, { label: "Doubles", n: 4 }, { label: "Rotating", n: 6 }] }),
      S({ id: "tennis", name: "Tennis", emoji: "🥎", typicalPlayers: 4, hasLevels: true,
          levelNames: ["Beginner", "Improver", "Intermediate", "Advanced"], isOutdoor: true, season: "summer",
          presets: [{ label: "Singles", n: 2 }, { label: "Doubles", n: 4 }] }),
      S({ id: "pickleball", name: "Pickleball", emoji: "🥒", typicalPlayers: 4, hasLevels: true,
          levelNames: ["Beginner", "Improver", "Intermediate", "Advanced"],
          presets: [{ label: "Doubles", n: 4 }, { label: "Rotating", n: 8 }] }),
      S({ id: "squash", name: "Squash", emoji: "🎯", typicalPlayers: 2, hasLevels: true, durationMin: 40,
          levelNames: ["Beginner", "Improver", "Intermediate", "Advanced"],
          presets: [{ label: "Singles", n: 2 }, { label: "Three rotating", n: 3 }] }),
      S({ id: "running", name: "Running", emoji: "👟", typicalPlayers: 8, isOutdoor: true,
          launchThreshold: 15, hasLevels: true, levelNames: ["Couch to 5k", "5k", "10k", "Half and up"],
          presets: [{ label: "Pair", n: 2 }, { label: "Small group", n: 6 }, { label: "Big group", n: 15 }] }),
    ];

    const V = (id: string, name: string, address: string, areaId: string, miles: number,
               pence: number, unit: string, sports: SportId[]): Venue => {
      this.venueSports[id] = sports;
      return { id, name, address, areaId, pricePence: pence, priceUnit: unit,
               bookingUrl: null, distanceMiles: miles };
    };

    this.venues = [
      V("v1", "Active Wigston", "Station Rd, Wigston", "LE18", 1.2, 2000, "hour", ["badminton", "squash"]),
      V("v2", "Wigston Tennis Club", "Blaby Rd", "LE18", 1.6, 1200, "hour", ["tennis"]),
      V("v3", "Grace Road nets", "Aylestone", "LE2", 2.8, 2400, "hour", ["cricket"]),
      V("v4", "Evington Park", "Evington", "LE5", 3.4, 0, "", ["cricket", "running"]),
      V("v5", "Aylestone Leisure Centre", "Knighton Lane East", "LE2", 4.1, 1600, "hour", ["badminton", "squash", "pickleball"]),
      V("v6", "Victoria Park", "Leicester", "LE2", 4.8, 0, "", ["cricket", "running", "football"]),
      V("v7", "Powerleague Leicester", "Meridian Way", "LE3", 5.5, 5500, "hour", ["football"]),
      V("v8", "Braunstone Leisure Centre", "Braunstone", "LE3", 5.6, 1800, "hour", ["badminton", "football"]),
      V("v9", "Padel4All Leicester", "Meridian Business Park", "LE3", 6.9, 3200, "90 min", ["padel"]),
    ];

    const P = (id: string, name: string, initials: string, miles: number,
               sports: Array<[SportId, string | null]>, attended: number, missed: number,
               isNew = false): MockPerson => ({
      id, name, initials, areaId: "LE18", distanceMiles: miles,
      sports: sports.map(([sportId, level]) => ({ sportId, level })),
      attended, missed, isNew,
    });

    this.people = [
      P("ar", "Arjun", "AR", 0.8, [["cricket", null], ["badminton", "Improver"]], 4, 0, true),
      P("pr", "Priya", "PR", 1.1, [["badminton", "Intermediate"], ["padel", "Improver"]], 23, 1),
      P("tm", "Tom", "TM", 1.4, [["badminton", "Intermediate"], ["football", null]], 31, 2),
      P("dk", "Dan", "DK", 2.0, [["badminton", "Improver"], ["cricket", null]], 9, 4),
      P("cw", "Chris", "CW", 5.1, [["cricket", null], ["football", null]], 12, 0),
      P("me2", "Meera", "ME", 4.6, [["badminton", "Beginner"], ["padel", "Beginner"]], 2, 0, true),
      P("rj", "Rehan", "RJ", 3.2, [["cricket", null], ["football", null]], 18, 1),
      P("sm", "Sam", "SM", 2.4, [["cricket", null], ["football", null]], 7, 1),
    ];

    this.games = [
      { id: "g1", sportId: "badminton", hostId: "tm", venueId: "v1", court: "Court 3",
        title: "Friday doubles", startsAt: days(3), durationMin: 60,
        costPence: 2000, spotsNeeded: 4,
        repeatsWeekly: true, approveRequired: false, beginnersWelcome: true,
        minLevel: null, splitTeams: false,
        note: "Chris can't make it this week. Beginners welcome — we're really not serious.",
        isBooked: true, hostPaidUpfront: true, cancelled: false,
        players: ["tm", "pr", "dk"], waitlist: [], asks: [], regulars: ["tm", "pr", "dk"],
        paid: ["tm"],
        messages: [
          { id: "m1", profileId: "tm", body: "Chris is out this week, so we're a player down", createdAt: days(-1) },
          { id: "m2", profileId: "pr", body: "I've asked at work. Nobody's biting.", createdAt: days(-1) },
          { id: "m3", profileId: "tm", body: "Putting it on Hangout then. Someone will turn up.", createdAt: days(-1) },
        ] },
      // Same sport, different shape. Badminton is not "always 4".
      { id: "g2", sportId: "badminton", hostId: "dk", venueId: "v5", court: "Courts 1–2",
        title: "Tuesday singles ladder", startsAt: days(5), durationMin: 60,
        costPence: 1600, spotsNeeded: 6,
        repeatsWeekly: true, approveRequired: true, beginnersWelcome: false,
        minLevel: "Intermediate", splitTeams: false,
        note: "Six of us, rotating singles. Not four — badminton is whatever you make it.",
        isBooked: true, hostPaidUpfront: true, cancelled: false,
        players: ["dk", "pr", "tm", "ar", "me2", "sm"], waitlist: [], asks: [],
        regulars: ["dk", "pr", "tm"], paid: ["dk", "pr"], messages: [] },
      { id: "g3", sportId: "cricket", hostId: "rj", venueId: "v4", court: "Top field",
        title: "Sunday tape-ball", startsAt: days(2), durationMin: 150,
        costPence: 0, spotsNeeded: 12,
        repeatsWeekly: true, approveRequired: false, beginnersWelcome: true,
        minLevel: null, splitTeams: true,
        note: "Every Sunday, rain or shine. All ages, all abilities. Free.",
        isBooked: true, hostPaidUpfront: false, cancelled: false,
        players: ["rj", "cw", "ar", "sm", "dk"], waitlist: [], asks: [],
        regulars: ["rj", "cw", "ar"], paid: [], messages: [] },
      { id: "g4", sportId: "cricket", hostId: "cw", venueId: "v3", court: "Net 2",
        title: "Thursday hardball nets", startsAt: days(4), durationMin: 90,
        costPence: 2400, spotsNeeded: 6,
        repeatsWeekly: false, approveRequired: true, beginnersWelcome: false,
        minLevel: null, splitTeams: false,
        note: "Hardball nets. Bring your kit if you've got it — spares available.",
        isBooked: false, hostPaidUpfront: false, cancelled: false,
        players: ["cw", "ar", "rj"], waitlist: [], asks: [], regulars: [], paid: [], messages: [] },
    ];

    // Football sits at 19 of 20 in LE18. One more person and it opens — which is
    // the density rule made visible, and the best moment in the app.
    const D = (sportId: SportId, areaId: string, want: number, threshold = 20): SportDemand => ({
      sportId, areaId, areaName: this.areas_.find((a) => a.id === areaId)?.name ?? areaId,
      wantCount: want, threshold, isLive: false,
      stillNeeded: Math.max(threshold - want, 0),
      // Venues you could actually PLAY at — i.e. within your radius. Counting only
      // venues in your own postcode reported "0 venues ready" for padel, whose court
      // is 6.9 miles away in LE3 — which guts the one line that makes someone want it.
      venuesHere: this.venues.filter(
        (v) => this.venueSports[v.id]?.includes(sportId)
            && (v.distanceMiles ?? 99) <= MAX_RADIUS_MILES,
      ).length,
    });

    const R = (id: string, name: string, ini: string, sportId: SportId, areaId: string,
               agoH: number, answered = false): SportRequest => ({
      id, personName: name, initials: ini, sportId, areaId,
      createdAt: new Date(Date.now() - agoH * 36e5).toISOString(),
      answered, demandHere: 0, threshold: 20,
    });
    this.requests_ = [
      R("r1", "Meera", "ME", "padel", "LE18", 2),
      R("r2", "Priya", "PR", "padel", "LE18", 5),
      R("r3", "Tom", "TM", "football", "LE18", 26),
      R("r4", "Chris", "CW", "football", "LE2", 48),
      R("r5", "Sam", "SM", "pickleball", "LE18", 96, true),
    ];

    this.demand_ = [
      D("football", "LE18", 19), D("football", "LE2", 16), D("football", "LE3", 11),
      D("padel", "LE18", 12), D("padel", "LE2", 9), D("padel", "LE3", 4),
      D("tennis", "LE18", 9), D("tennis", "LE2", 13),
      D("pickleball", "LE18", 4), D("squash", "LE18", 6),
      D("running", "LE18", 11, 15), D("running", "LE2", 18, 15),
    ];

    // Each request carries the demand in THEIR postcode — the only number that
    // means anything. "34 people in Leicester" is a vanity metric.
    for (const r of this.requests_) {
      const row = this.demand_.find((d) => d.sportId === r.sportId && d.areaId === r.areaId);
      r.demandHere = row?.wantCount ?? 0;
      r.threshold = row?.threshold ?? 20;
    }
  }
}

export { splitSides };
