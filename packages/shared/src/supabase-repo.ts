/**
 * supabase-repo.ts — the real backend.
 *
 * NOT WIRED UP YET. There is no Supabase project, because there is no Supabase
 * account, because Shiv was away and I was not going to create accounts in his
 * name. Every credential below is read from the environment and is currently
 * absent. See BUILD_LOG.md for the exact list of what to paste in.
 *
 * What this file IS: the proof that the swap is genuinely one line. Every method
 * maps to the SQL that already exists and is already tested in packages/db —
 * `app.join_game()` is the locked join, `games_near_me` is the 25-mile-capped
 * discovery view, `games_public` is the disclosure ladder. The hard thinking is
 * in the database. This is a thin translation layer, deliberately.
 *
 * To go live:
 *   1. Create a Supabase project (EU/London region — the users are in Leicester
 *      and the data is personal; keep it under UK GDPR).
 *   2. Run packages/db/migrations/*.sql in order, then seed/seed.sql.
 *   3. Put SUPABASE_URL and SUPABASE_ANON_KEY in apps/mobile/.env
 *   4. In App.tsx:  const repo: Repo = new SupabaseRepo(url, anonKey);
 *
 * Nothing else in the app changes. That is the whole point of the Repo
 * interface, and it is why MockRepo was written to be exactly as strict as the
 * RLS rather than conveniently permissive.
 */

import type {
  Repo, Profile, Sport, SportId, Area, Venue, Person,
  PublicGame, Game, JoinOutcome, PostGameInput, SportDemand,
} from "./types";
import { clampRadius } from "./domain";

/** Minimal shape of the supabase-js client we depend on. Keeps this file
 *  compiling before `npm i @supabase/supabase-js` has been run. */
interface SupabaseLike {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: any; error: any }>;
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null } }>;
  };
}

/** supabase-js returns { data, error }. Until the real client is installed the
 *  rows are untyped, so we surface them as `any` at exactly one place rather
 *  than sprinkling casts through every method. When @supabase/supabase-js and
 *  generated DB types land, delete the `any` here and the compiler will point
 *  at anything that was quietly wrong. */
function unwrap(res: { data: any; error: any }): any {
  if (res.error) throw new Error(res.error.message ?? String(res.error));
  return res.data;
}

export class SupabaseRepo implements Repo {
  constructor(private sb: SupabaseLike) {}

  async me(): Promise<Profile | null> {
    const { data } = await this.sb.auth.getUser();
    if (!data.user) return null;
    const row = unwrap(await this.sb.from("profiles").select("*").eq("id", data.user.id).single());
    const sports = unwrap(await this.sb.from("profile_sports").select("sport_id, level").eq("profile_id", data.user.id));
    return {
      id: row.id, displayName: row.display_name, initials: row.initials,
      areaId: row.area_id, radiusMiles: row.radius_miles,
      isNewToArea: row.is_new_to_area, discoverable: row.discoverable,
      notify: row.notify, isAdult: row.is_adult, isAdmin: row.is_admin,
      gamesAttended: row.games_attended, gamesMissed: row.games_missed,
      sports: sports.map((s: any) => ({ sportId: s.sport_id as SportId, level: s.level })),
    };
  }

  async signUp(): Promise<Profile> {
    // Sign-up runs through Supabase Auth (email or phone OTP), then a trigger
    // creates the profiles row. Phone verification is worth the friction: it is
    // one account per human, and it makes ban-evasion expensive.
    throw new Error("Wire up Supabase Auth first — see BUILD_LOG.md");
  }

  async sports(): Promise<Sport[]> {
    const rows = unwrap(await this.sb.from("sports").select("*"));
    return rows.map((r: any) => ({
      id: r.id, name: r.name, emoji: r.emoji,
      typicalPlayers: r.typical_players,       // a SUGGESTION. Never a rule.
      presets: r.presets, hasTeams: r.has_teams, hasLevels: r.has_levels,
      levelNames: r.level_names, kit: r.kit, durationMin: r.duration_min,
      isOutdoor: r.is_outdoor, weatherDependent: r.weather_dependent,
      season: r.season, guides: r.guides,
      launchThreshold: r.launch_threshold, globallyLive: r.globally_live,
    }));
  }

  async areas(): Promise<Area[]> {
    const rows = unwrap(await this.sb.from("areas").select("id, name"));
    return rows.map((r: any) => ({ id: r.id, name: r.name }));
  }

  async venuesFor(sportId: SportId): Promise<Venue[]> {
    const rows = unwrap(
      await this.sb.from("venue_sports")
        .select("venues(id, name, address, area_id, price_pence, price_unit, booking_url)")
        .eq("sport_id", sportId),
    );
    return rows.map((r: any) => ({
      id: r.venues.id, name: r.venues.name, address: r.venues.address,
      areaId: r.venues.area_id, pricePence: r.venues.price_pence,
      priceUnit: r.venues.price_unit, bookingUrl: r.venues.booking_url,
    }));
  }

  /**
   * Discovery. The 25-mile cap and the "sport must be live in your area" rule
   * are enforced INSIDE the view — this client cannot ask for more, however it
   * is called. That is deliberate: a client-side cap is a suggestion.
   */
  async gamesNearMe(): Promise<PublicGame[]> {
    const rows = unwrap(await this.sb.from("games_near_me").select("*"));
    return rows.map(toPublic);
  }

  /**
   * THE DISCLOSURE LADDER.
   *
   * We ask game_detail first. If you are not a member the RLS on `games` returns
   * ZERO ROWS — not a filtered row, no row — and we fall back to games_public,
   * which has no venue column to leak. The branch below is the ladder.
   */
  async game(id: string): Promise<Game | null> {
    const detail = unwrap(await this.sb.from("game_detail").select("*").eq("id", id).maybeSingle());

    if (!detail) {
      const pub = unwrap(await this.sb.from("games_public").select("*").eq("id", id).maybeSingle());
      return pub ? toPublic(pub) : null;
    }

    const [players, waitlist, asks, messages] = await Promise.all([
      this.sb.from("game_players").select("profile_id, paid_at, profiles(display_name, initials, games_attended, games_missed)").eq("game_id", id).then(unwrap),
      this.sb.from("game_waitlist").select("profile_id, profiles(display_name, initials, games_attended, games_missed)").eq("game_id", id).then(unwrap),
      this.sb.from("game_asks").select("profile_id, profiles(display_name, initials, games_attended, games_missed)").eq("game_id", id).then(unwrap),
      this.sb.from("game_messages").select("*, profiles(display_name)").eq("game_id", id).order("created_at").then(unwrap),
    ]);

    const roster = (rows: any[]) => rows.map((r: any) => ({
      profileId: r.profile_id,
      displayName: r.profiles?.display_name ?? "Someone",
      initials: r.profiles?.initials ?? "?",
      level: null,
      gamesAttended: r.profiles?.games_attended ?? 0,
      gamesMissed: r.profiles?.games_missed ?? 0,
      paid: !!r.paid_at,
      isHost: r.profile_id === detail.host_id,
    }));

    return {
      ...toPublic({ ...detail, distance_miles: 0 }),
      kind: "member",
      venueName: detail.venue_name,
      venueAddress: detail.venue_address,
      venueBookingUrl: detail.venue_booking_url,
      court: detail.court,
      players: roster(players), waitlist: roster(waitlist), asks: roster(asks),
      hostId: detail.host_id,
      hostName: roster(players).find((p) => p.isHost)?.displayName ?? "the host",
      messages: messages.map((m: any) => ({
        id: m.id, profileId: m.profile_id,
        authorName: m.profiles?.display_name ?? null,
        body: m.body, createdAt: m.created_at,
      })),
    };
  }

  /**
   * The last spot. All the correctness lives in Postgres — the FOR UPDATE row
   * lock in app.join_game(). This is a one-line RPC on purpose: there is no
   * client-side check to get wrong, and no retry loop to write.
   */
  async joinGame(id: string): Promise<JoinOutcome> {
    const { data, error } = await this.sb.rpc("join_game", { p_game_id: id });
    if (error) throw new Error(error.message);
    return data as JoinOutcome;
  }

  async leaveGame(id: string): Promise<void> {
    unwrap(await this.sb.rpc("leave_game", { p_game_id: id }));
  }

  async acceptAsk(gameId: string, profileId: string): Promise<void> {
    unwrap(await this.sb.rpc("accept_ask", { p_game_id: gameId, p_profile_id: profileId }));
  }

  async postGame(i: PostGameInput): Promise<string> {
    return unwrap(await this.sb.rpc("post_game", {
      p_sport_id: i.sportId, p_venue_id: i.venueId, p_title: i.title,
      p_starts_at: i.startsAt,
      p_spots_needed: i.spotsNeeded,       // ANY number. The host decides.
      p_cost_pence: i.costPence,
      p_court: i.court ?? null,
      p_repeats_weekly: !!i.repeatsWeekly,
      p_approve_required: !!i.approveRequired,
      p_beginners_welcome: i.beginnersWelcome ?? true,
      p_min_level: i.minLevel ?? null,
      p_split_teams: !!i.splitTeams,
      p_note: i.note ?? null,
    })) as string;
  }

  async sendMessage(gameId: string, body: string): Promise<void> {
    const { data } = await this.sb.auth.getUser();
    unwrap(await this.sb.from("game_messages").insert({
      game_id: gameId, profile_id: data.user?.id, body,
    }));
  }

  /** Bands, never decimals. The view does not compute an exact distance. */
  async peopleNearMe(): Promise<Person[]> {
    const rows = unwrap(await this.sb.from("people_near_me").select("*"));
    return rows.map((r: any) => ({
      id: r.id, displayName: r.display_name, initials: r.initials,
      isNewToArea: r.is_new_to_area,
      gamesAttended: r.games_attended, gamesMissed: r.games_missed,
      distanceBand: r.distance_band,
    }));
  }

  /**
   * The standing fixture. `my_weekly_prompts` only returns rows where the
   * question is genuinely open — you're a regular and have said neither yes nor
   * no. Silence is not a yes, and the view refuses to pretend otherwise.
   */
  async weeklyPrompts(): Promise<import("./types").WeeklyPrompt[]> {
    const rows = unwrap(await this.sb.from("my_weekly_prompts").select("*"));
    return rows.map((r: any) => ({
      gameId: r.game_id, sportId: r.sport_id, title: r.title, startsAt: r.starts_at,
      playerCount: r.player_count, spotsNeeded: r.spots_needed, spotsLeft: r.spots_left,
      areaName: r.area_name, distanceMiles: Number(r.distance_miles ?? 0),
      answered: r.answered, regulars: r.regulars,
    }));
  }

  /** Out this week. Locks the game, because saying no opens a spot. */
  async cantMakeIt(gameId: string): Promise<void> {
    unwrap(await this.sb.rpc("cant_make_it", { p_game_id: gameId }));
  }

  async becomeRegular(gameId: string): Promise<void> {
    unwrap(await this.sb.rpc("become_regular", { p_game_id: gameId }));
  }

  async demand(): Promise<SportDemand[]> {
    const rows = unwrap(await this.sb.from("admin_demand").select("*"));
    return rows.map((r: any) => ({
      sportId: r.sport_id, areaId: r.area_id, areaName: r.area_name,
      wantCount: r.want_count, threshold: r.launch_threshold,
      isLive: r.is_live, stillNeeded: r.still_needed, venuesHere: r.venues_here,
    }));
  }

  /** Admin inbox. RLS on sport_requests already restricts this to admins. */
  async sportRequests(): Promise<import("./types").SportRequest[]> {
    const rows = unwrap(await this.sb.from("sport_requests")
      .select("id, sport_id, area_id, created_at, profiles(display_name, initials), sport_request_messages(id)")
      .order("created_at", { ascending: false }));
    return rows.map((r: any) => ({
      id: r.id,
      personName: r.profiles?.display_name ?? "Someone",
      initials: r.profiles?.initials ?? "?",
      sportId: r.sport_id, areaId: r.area_id,
      createdAt: r.created_at,
      answered: (r.sport_request_messages?.length ?? 0) > 0,
      demandHere: 0, threshold: 20,
    }));
  }

  async replyToRequest(id: string, body: string): Promise<void> {
    unwrap(await this.sb.from("sport_request_messages")
      .insert({ request_id: id, from_admin: true, body }));
  }

  async blockUser(profileId: string): Promise<void> {
    unwrap(await this.sb.rpc("block_user", { p_other: profileId }));
  }

  async reportUser(profileId: string, reason: string, detail?: string): Promise<void> {
    unwrap(await this.sb.rpc("report_user", {
      p_reported: profileId, p_reason: reason, p_detail: detail ?? null,
    }));
  }

  /** Deletes the profile. The auth.users row is removed by an Edge Function
   *  using the service-role key — the client cannot and must not do that. */
  async deleteMyAccount(): Promise<void> {
    unwrap(await this.sb.rpc("delete_my_account"));
  }

  async wantSport(sportId: SportId): Promise<boolean> {
    return unwrap(await this.sb.rpc("want_sport", { p_sport_id: sportId })) as boolean;
  }

  /** clampRadius here is belt; the CHECK constraint in Postgres is braces. */
  async setRadius(miles: number): Promise<void> {
    const { data } = await this.sb.auth.getUser();
    unwrap(await this.sb.from("profiles")
      .update({ radius_miles: clampRadius(miles) })
      .eq("id", data.user?.id));
  }
}

function toPublic(r: any): PublicGame {
  return {
    kind: "public",
    id: r.id, sportId: r.sport_id, title: r.title, startsAt: r.starts_at,
    durationMin: r.duration_min, costPence: r.cost_pence,
    spotsNeeded: r.spots_needed, playerCount: r.player_count,
    spotsLeft: r.spots_left ?? Math.max(r.spots_needed - r.player_count, 0),
    repeatsWeekly: r.repeats_weekly, approveRequired: r.approve_required,
    beginnersWelcome: r.beginners_welcome, minLevel: r.min_level,
    splitTeams: r.split_teams, note: r.note,
    isBooked: r.is_booked, cancelled: r.cancelled,
    areaId: r.area_id, areaName: r.area_name,
    distanceMiles: Number(r.distance_miles ?? 0),
    hostAttended: r.host_attended ?? 0, hostMissed: r.host_missed ?? 0,
    iAmIn: !!r.i_am_in, iHaveAsked: !!r.i_have_asked,
    iAmWaiting: !!r.i_am_waiting, iAmHost: !!r.i_am_host,
  };
}
