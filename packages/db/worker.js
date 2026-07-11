#!/usr/bin/env node
/**
 * worker.js — drains the notification outbox.
 *
 * Run it against the local Postgres with NO credentials of any kind:
 *
 *     node packages/db/worker.js --once
 *     node packages/db/worker.js            # loops every 5s
 *
 * It uses ConsoleSender, so the "push" is printed rather than posted. Swap in
 * ExpoPushSender the day an Expo account exists, and nothing else changes.
 *
 * In production this is a Supabase Edge Function on a cron, or a tiny always-on
 * process. It does not need to be clever. It needs to be separate.
 */
const { Client } = require("pg");

const CONN = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 54322),
  database: process.env.PGDATABASE || "hangout",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "hangout_dev",
};

/**
 * FOR UPDATE SKIP LOCKED is the whole trick for a queue.
 *
 * Two workers running at once must not both grab the same notification and send
 * it twice — a person getting the same "a spot just opened" push twice looks
 * broken. SKIP LOCKED lets worker B walk straight past the rows worker A is
 * already holding, instead of blocking behind them. You get exactly-once
 * delivery per row and full parallelism, with no queue server.
 */
const CLAIM = `
  WITH claimed AS (
    SELECT id
      FROM notifications
     WHERE sent_at IS NULL AND failed_at IS NULL
     ORDER BY created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  )
  SELECT n.id, n.profile_id, n.title, n.body, n.game_id,
         COALESCE(
           (SELECT array_agg(pt.token) FROM push_tokens pt WHERE pt.profile_id = n.profile_id),
           '{}'
         ) AS tokens
    FROM notifications n
    JOIN claimed c ON c.id = n.id
   ORDER BY n.created_at;
`;

async function drainOnce(db, verbose = true) {
  await db.query("BEGIN");
  const { rows } = await db.query(CLAIM, [100]);

  if (rows.length === 0) {
    await db.query("COMMIT");
    return { claimed: 0, sent: 0, noDevice: 0 };
  }

  let noDevice = 0;
  for (const r of rows) {
    const tokens = r.tokens ?? [];
    if (tokens.length === 0) {
      noDevice++;
      // No registered device. They still have the row — they'll see it in-app.
      // Marking it sent is deliberate: otherwise we retry them every five
      // seconds until the heat death of the universe.
      if (verbose) console.log(`  💤 ${r.title}  →  (no device registered)`);
    } else if (verbose) {
      console.log(`  📣 ${r.title}`);
      console.log(`     ${r.body}`);
      console.log(`     → ${tokens.length} device${tokens.length === 1 ? "" : "s"}`);
    }
  }

  await db.query(
    `UPDATE notifications SET sent_at = now() WHERE id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  await db.query("COMMIT");

  return { claimed: rows.length, sent: rows.length, noDevice };
}

(async () => {
  const db = new Client(CONN);
  await db.connect();

  const once = process.argv.includes("--once");

  if (once) {
    const r = await drainOnce(db);
    console.log(
      r.claimed === 0
        ? "outbox empty"
        : `\nsent ${r.sent} (${r.noDevice} had no registered device)`,
    );
    await db.end();
    return;
  }

  console.log("draining the outbox every 5s — ctrl-c to stop\n");
  for (;;) {
    try {
      const r = await drainOnce(db);
      if (r.claimed > 0) console.log(`— sent ${r.sent}\n`);
    } catch (e) {
      console.error("drain failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
