/**
 * push.test.ts — the postman.
 *
 * The audience is decided in SQL and tested in packages/db/test/notify.test.js.
 * What is left to get wrong here is delivery: sending twice, retrying forever,
 * or silently dropping people. All three are quiet failures that look like
 * "nobody was interested".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  drainOutbox, ConsoleSender,
  type PushMessage, type PushSender, type SendResult, type OutboxStore,
} from "../src/push";

const msg = (id: string, tokens: string[]): PushMessage => ({
  id, profileId: `p-${id}`, tokens,
  title: "🏸 A spot just opened",
  body: "Friday doubles · Fri 7:00pm · 1.2 miles away",
  data: { gameId: "g1" },
});

class FakeStore implements OutboxStore {
  sentIds: string[] = [];
  failed: Array<{ id: string; error: string }> = [];
  deletedTokens: string[] = [];
  constructor(private queue: PushMessage[]) {}
  async claim(limit: number) { return this.queue.splice(0, limit); }
  async markSent(ids: string[]) { this.sentIds.push(...ids); }
  async markFailed(id: string, error: string) { this.failed.push({ id, error }); }
  async deleteToken(token: string) { this.deletedTokens.push(token); }
}

describe("draining the outbox", () => {
  test("an empty outbox does nothing at all", async () => {
    const store = new FakeStore([]);
    const r = await drainOutbox(store, new ConsoleSender());
    assert.deepEqual(r, { claimed: 0, sent: 0, failed: 0, deadTokensRemoved: 0 });
    assert.equal(store.sentIds.length, 0);
  });

  test("one person with two devices gets one notification, posted to both", async () => {
    const sender = new ConsoleSender();
    const store = new FakeStore([msg("n1", ["tok-phone", "tok-tablet"])]);
    const r = await drainOutbox(store, sender);
    assert.equal(r.claimed, 1);
    assert.equal(r.sent, 1);
    assert.equal(sender.sent[0].tokens.length, 2);
  });

  test("a person with NO device is marked sent, not retried forever", async () => {
    // They still have the row and will see it in-app. But if we left it unsent,
    // the worker would pick it up every five seconds until the heat death of
    // the universe, and the outbox would never drain.
    const store = new FakeStore([msg("n1", [])]);
    const r = await drainOutbox(store, new ConsoleSender());
    assert.equal(r.sent, 1);
    assert.deepEqual(store.sentIds, ["n1"]);
    assert.equal(r.failed, 0);
  });

  test("a dead token is deleted — an uninstalled app must not be chased", async () => {
    const dying: PushSender = {
      async send(ms) {
        return ms.map((m): SendResult => ({
          id: m.id, ok: false, error: "DeviceNotRegistered",
          tokenIsDead: m.tokens[0],
        }));
      },
    };
    const store = new FakeStore([msg("n1", ["ExponentPushToken[gone]"])]);
    const r = await drainOutbox(store, dying);
    assert.equal(r.failed, 1);
    assert.equal(r.deadTokensRemoved, 1);
    assert.deepEqual(store.deletedTokens, ["ExponentPushToken[gone]"]);
    assert.equal(store.sentIds.length, 0, "a failed send is not marked sent");
    assert.equal(store.failed[0].error, "DeviceNotRegistered");
  });

  test("a failure does not take the whole batch down with it", async () => {
    // One bad token in a batch of forty must not silence the other thirty-nine.
    const flaky: PushSender = {
      async send(ms) {
        return ms.map((m): SendResult =>
          m.id === "bad" ? { id: m.id, ok: false, error: "boom" } : { id: m.id, ok: true });
      },
    };
    const store = new FakeStore([
      msg("good1", ["t1"]), msg("bad", ["t2"]), msg("good2", ["t3"]),
    ]);
    const r = await drainOutbox(store, flaky);
    assert.equal(r.sent, 2, "the two good ones went");
    assert.equal(r.failed, 1);
    assert.ok(store.sentIds.includes("good1") && store.sentIds.includes("good2"));
    assert.ok(!store.sentIds.includes("bad"));
  });

  test("nothing is sent twice — a drained row is not reclaimed", async () => {
    const sender = new ConsoleSender();
    const store = new FakeStore([msg("n1", ["t1"])]);
    await drainOutbox(store, sender);
    await drainOutbox(store, sender);   // second pass, same store
    assert.equal(sender.sent.length, 1,
      "the same person must never get the same 'spot opened' push twice");
  });

  test("mixed batch: some reachable, some not", async () => {
    const sender = new ConsoleSender();
    const store = new FakeStore([
      msg("has-device", ["t1"]),
      msg("no-device", []),
      msg("two-devices", ["t2", "t3"]),
    ]);
    const r = await drainOutbox(store, sender);
    assert.equal(r.claimed, 3);
    assert.equal(r.sent, 3, "all three rows leave the outbox");
    assert.equal(sender.sent.length, 2, "…but only two were actually posted to a phone");
  });
});
