/**
 * push.ts — sending the shout.
 *
 * The database has already decided WHO gets told (app.notify_targets) and
 * written the rows (the outbox). This file is only the postman.
 *
 * It is behind an interface for a reason that is not architectural purity:
 * there is no Expo account yet, so `ExpoPushSender` cannot run. `ConsoleSender`
 * can, today, with nothing — which means the whole loop is exercisable end to
 * end right now, and the day the credentials arrive we change one line.
 */

export interface PushMessage {
  id: string;
  profileId: string;
  tokens: string[];       // a person may have a phone and a tablet
  title: string;
  body: string;
  data?: Record<string, unknown>;   // { gameId } — so the tap opens the game
}

export interface SendResult {
  id: string;
  ok: boolean;
  error?: string;
  /** Expo tells us when a token is dead. We must delete it or we will retry
   *  forever against a phone that has been factory-reset and thrown in a drawer. */
  tokenIsDead?: string;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<SendResult[]>;
}

/* ────────────────────────────────────────────────────────────────────────
   Works today. No account, no key, no network.
   ──────────────────────────────────────────────────────────────────────── */
export class ConsoleSender implements PushSender {
  public sent: PushMessage[] = [];

  async send(messages: PushMessage[]): Promise<SendResult[]> {
    for (const m of messages) {
      this.sent.push(m);
      // eslint-disable-next-line no-console
      console.log(`  📣 → ${m.profileId}  ${m.title}\n       ${m.body}`);
    }
    return messages.map((m) => ({ id: m.id, ok: true }));
  }
}

/* ────────────────────────────────────────────────────────────────────────
   The real one. NEEDS CREDENTIALS — see BUILD_LOG.md.
   ──────────────────────────────────────────────────────────────────────── */
export class ExpoPushSender implements PushSender {
  private endpoint = "https://exp.host/--/api/v2/push/send";

  /** accessToken is only needed if you enable Expo's "enhanced push security". */
  constructor(private accessToken?: string) {}

  async send(messages: PushMessage[]): Promise<SendResult[]> {
    if (messages.length === 0) return [];

    // Expo's API takes at most 100 per request. Exceeding it doesn't error
    // helpfully — it just drops people, which is the worst kind of bug: silent,
    // and it looks like "nobody was interested".
    const CHUNK = 100;
    const results: SendResult[] = [];

    for (let i = 0; i < messages.length; i += CHUNK) {
      const chunk = messages.slice(i, i + CHUNK);

      // One Expo message per TOKEN, not per person.
      const payload = chunk.flatMap((m) =>
        m.tokens.map((to) => ({
          to,
          title: m.title,
          body: m.body,
          data: m.data ?? {},
          sound: "default",
          // High priority: this is time-critical. A game is on Friday and the
          // shout is worthless on Saturday.
          priority: "high",
          channelId: "spots",
        })),
      );

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        results.push(...chunk.map((m) => ({ id: m.id, ok: false, error: `HTTP ${res.status}: ${text}` })));
        continue;
      }

      const json = (await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string; expoPushToken?: string } }> };
      const tickets = json.data ?? [];

      let k = 0;
      for (const m of chunk) {
        let ok = true;
        let error: string | undefined;
        let dead: string | undefined;

        for (const token of m.tokens) {
          const ticket = tickets[k++];
          if (ticket?.status === "error") {
            ok = false;
            error = ticket.message;
            // DeviceNotRegistered = the app was uninstalled. Delete the token.
            if (ticket.details?.error === "DeviceNotRegistered") dead = token;
          }
        }
        results.push({ id: m.id, ok, error, tokenIsDead: dead });
      }
    }

    return results;
  }
}

/* ────────────────────────────────────────────────────────────────────────
   THE WORKER
   Drains the outbox. Deliberately dumb, and deliberately separate from any
   transaction that matters.
   ──────────────────────────────────────────────────────────────────────── */

/** The bits of a DB client the worker needs. Keeps this testable with a fake. */
export interface OutboxStore {
  /** Unsent notifications, oldest first, with the recipient's device tokens. */
  claim(limit: number): Promise<PushMessage[]>;
  markSent(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  deleteToken(token: string): Promise<void>;
}

export interface DrainReport {
  claimed: number;
  sent: number;
  failed: number;
  deadTokensRemoved: number;
}

/**
 * Drain the outbox once.
 *
 * Notice what this does NOT do: it does not decide who gets told. That decision
 * was made in SQL, inside the transaction that opened the spot, where it could
 * see the truth. By the time we get here the audience is settled and the only
 * remaining question is whether the bytes arrive.
 */
export async function drainOutbox(
  store: OutboxStore,
  sender: PushSender,
  limit = 100,
): Promise<DrainReport> {
  const batch = await store.claim(limit);
  if (batch.length === 0) {
    return { claimed: 0, sent: 0, failed: 0, deadTokensRemoved: 0 };
  }

  // Someone with no registered device still gets a row (so they see it in-app
  // next time they open it) but there is nothing to post to a phone.
  const sendable = batch.filter((m) => m.tokens.length > 0);
  const unreachable = batch.filter((m) => m.tokens.length === 0);

  const results = sendable.length ? await sender.send(sendable) : [];

  const sentIds = results.filter((r) => r.ok).map((r) => r.id);
  // A person with no device is "sent" as far as the outbox is concerned —
  // otherwise we would retry them forever, every minute, until the heat death
  // of the universe.
  sentIds.push(...unreachable.map((m) => m.id));

  if (sentIds.length) await store.markSent(sentIds);

  let dead = 0;
  for (const r of results) {
    if (!r.ok) await store.markFailed(r.id, r.error ?? "unknown");
    if (r.tokenIsDead) { await store.deleteToken(r.tokenIsDead); dead++; }
  }

  return {
    claimed: batch.length,
    sent: sentIds.length,
    failed: results.filter((r) => !r.ok).length,
    deadTokensRemoved: dead,
  };
}
