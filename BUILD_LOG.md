# Build log

**Status: working, tested, committed foundation.** Built while you were away.

Nothing is faked in the parts that matter. The database is real Postgres with real
PostGIS. The security rules are real RLS policies proven against a non-superuser.
The race condition is proven by *breaking it on purpose* and watching it break.

---

## Run it right now (no accounts, no keys)

```bash
npm install

# the app — runs on MockRepo, nothing leaves your phone
npm -w @hangout/mobile start          # then press i (iOS) / a (Android) / w (web)

# the database — real Postgres + PostGIS in Docker
docker start hangout-db || docker run -d --name hangout-db \
  -e POSTGRES_PASSWORD=hangout_dev -e POSTGRES_DB=hangout \
  -p 54322:5432 postgis/postgis:16-3.4
./packages/db/reset.sh

# everything
npm test
```

---

## What's proven, and how

| Suite | Checks | What it actually proves |
|---|---|---|
| `db/test/security.test.js` | **36** | A non-member cannot read the venue, court, roster or chat. Zero rows — not a filtered answer, no answer. |
| `db/test/race.test.js` | **16** | 10 people tap "I'm in" on a 1-spot game → exactly 1 gets in. The *naive* version double-books, so the lock is proven load-bearing. |
| `db/test/notify.test.js` | **26** | Who gets told — and, mostly, **who does not**. |
| `db/test/weekly.test.js` | **14** | Silence is not a yes. The standing fixture. |
| `shared/test/*.test.ts` | **45** | Money in integer pence, the ladder as a type, the mock no more permissive than Postgres, the push outbox. |
| Expo app (browser-driven) | **48** | The ladder is visible on screen; the weekly prompt appears and disappears; the admin board ranks by best area. |

**185 checks. All passing.**

### The one I'd point at first

`race.test.js` doesn't just test the correct code. It also builds the naive join
every developer writes the first time — read the count, check it, insert, no lock —
and runs the identical race against it:

```
  ✓ EXACTLY ONE person got the spot (got 1)
  ✓ the game has exactly 4 players — never 5

  naive outcomes: ["joined","joined","joined","joined","joined",…]
  ✓ the NAIVE join double-books: 10 people "got" the last spot
  ✓ the naive game now has 13 players at a 4-person court
  → therefore SELECT … FOR UPDATE is load-bearing, not decoration
```

A test that only shows the correct code passing tells you nothing about whether
the lock matters. This one shows you the crater.

### The trap I nearly fell into

The security suite connects as **`app_user`, not `postgres`**. Superusers *bypass
RLS silently* — no error, no warning. A test suite running as `postgres` watches
every policy pass and proves absolutely nothing. It's the security equivalent of
testing your lock by walking through the wall. There's an assertion at the top of
the suite that fails loudly if this ever regresses.

---

## Every design decision, and where it lives

| Decision | Enforced where |
|---|---|
| **Disclosure ladder** — no venue/court/names/chat until you're in | RLS on `games`, `game_players`, `game_messages` + the `games_public` view, which has *no venue column to leak* |
| …and the UI can't leak it either | `PublicGame` has **no `venueName` field**. Not optional — absent. Delete the `isMember()` guard and it stops compiling. |
| **No true location, ever** | There is no column for one. `approx_location` is a jittered district centroid, and `set_my_area()` takes a *postcode* — there is no parameter for a latitude. |
| **Distances to people are bands** | `people_near_me` doesn't compute an exact distance. Three exact distances triangulate to an address. |
| **25-mile hard cap** | `CHECK (radius_miles between 1 and 25)` + `set_my_area()` refuses 40 + the view clamps. Three layers; a client-side cap is a suggestion. |
| **The last spot** | `SELECT … FOR UPDATE` in `app.join_game()` |
| **Nothing is fixed** | `spots_needed` is a column with a 2–50 check. Presets are shortcuts. Badminton is 4 *and* 6 in the seed data, on purpose. |
| **Cost belongs to the venue, not the sport** | `games.cost_pence`. Park cricket is free; the Grace Road nets are £24. |
| **Host approves, never the admin** | `games.approve_required` + `app.accept_ask()` checks `host_id = current_user`. Admin is not in the loop. |
| **Density thresholds** | `sport_areas` + `app.want_sport()`, which locks the row so the sport flips live exactly once |
| **18+ only** | `app.join_game()` raises if `NOT is_adult` |
| **Money is integer pence** | Exhaustive test: every split of every amount to £50, 2–20 ways, sums back exactly |

---

## ⚠️ Credentials I did NOT create in your name

I deliberately created **no accounts** and **no API keys**. Everything below is a
gap you fill, and nothing depends on it to run today.

| What | Why it's needed | Status |
|---|---|---|
| **Supabase project** | The real backend | ❌ Not created. Use the **London/EU region** — your users are in Leicester and the data is personal. UK GDPR. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Connect the app | ❌ Not set. Go in `apps/mobile/.env` |
| **Expo / EAS account** | Build for the stores + OTA updates | ❌ Not created |
| **Apple Developer** (£79/yr) | Ship to iOS | ❌ Not bought |
| **Google Play** (£20 one-off) | Ship to Android | ❌ Not bought |
| Sentry, PostHog | Errors, analytics | ❌ Not created. Free tiers are plenty. |
| Local Postgres password | Dev only | ✅ `hangout_dev` — obviously not a secret; it's a throwaway Docker container |

### Going live is genuinely one line

Once Supabase exists:

1. Run `packages/db/migrations/*.sql` in order, then `seed/seed.sql`.
2. Put the URL and anon key in `apps/mobile/.env`.
3. In `App.tsx`, change:
   ```diff
   - const repo: Repo = new MockRepo();
   + const repo: Repo = new SupabaseRepo(createClient(url, anonKey));
   ```

Nothing else moves. That's *why* MockRepo was written to be exactly as strict as
the RLS instead of conveniently permissive — so no screen is built against data the
real database will refuse to send.

---

## Two bugs the tests caught that I'd otherwise have shipped

**"0 venues ready."** The Sports screen told you padel had *zero* places to play near
LE18 — because I counted venues *in the same postcode*, and Padel4All sits in LE3,
6.9 miles away. That single wrong number guts the only line that makes somebody
want the sport. It's now "venues within your radius", fixed in both the mock and
the SQL. **I only saw it because I screenshotted the running app.**

**The poisoned transaction.** My first security suite crashed rather than failed,
because a rejected statement aborts the whole Postgres transaction and every
later assertion died with "transaction is aborted" instead of the message it was
checking for. Expected rejections are now fenced with savepoints. A test that
crashes is a test that isn't testing.

---

## Iteration 2 — push notifications

The core loop **is** the push. So the thing that had to be right was never the
transport (Expo and Apple will deliver the bytes) — it was the **audience**.

It fails in two directions and both end the app:

- **too narrow** → the person who would have turned up never hears, the court sits empty
- **too wide** → you ping a beginner about a competitive game 22 miles away, they turn
  notifications off, and you can **never reach them again**

Notification permission is a one-way door. You get to be wrong about this twice.
So most of `notify.test.js` asserts on who is **not** woken up.

**A real bug it caught:** Priya dropped out of the Friday game and was instantly
pinged *"🏸 2 spots just opened"* — about the spot **she had just vacated**. Absurd,
and the first thing a user would screenshot.

**The push body must not leak the venue.** A push is read on a lock screen, in
public, by whoever is looking over your shoulder. The disclosure ladder does not
get a holiday because the text is short. A `spot_open` push says *"0.3 miles
away"*. A `let_in` push — sent only to someone who is now a member — names Grace
Road.

**The outbox.** The transaction writes a row and sends nothing. Calling Expo's API
inside the transaction would hold the row lock on `games` while an HTTP call
hangs (nobody in Leicester can join anything), and a rollback *after* the send
means 38 people were told about a spot that doesn't exist. The worker uses
`FOR UPDATE SKIP LOCKED`, so two workers never send the same push twice.

Runs end to end **today, with zero credentials**:

```bash
npm run worker -- --once     # ConsoleSender prints the push instead of posting it
```

**When to ask for permission** is documented in `apps/mobile/src/push.ts`: never on
launch (you'll be declined forever before showing any value) — but right after
someone joins their first game, when the ask writes itself: *"Want to know if
someone drops out?"* That isn't a permission request. That's the product.

---

## Iteration 3 — the standing fixture, and the admin console

**Silence is not a yes.** An unanswered regular is a question, never an
attendance. Treat it as a yes and the host turns up to a booked court expecting
six and finds two. The weekly prompt has two buttons and **no way to dismiss it**
— both options are an answer — and it vanishes the moment you answer, either way.

**Saying no does not remove you from the crew.** "I can't make Friday" is not
"take me off the list forever". Conflating those is how apps quietly shed their
most loyal users.

**An RLS bug the test caught, and it was a bad one:** saying "can't make it"
removes you from the roster — and the disclosure ladder then treated you as a
**stranger to your own standing fixture**. You could no longer see the game, or
even the prompt asking whether you were in. Say no to the Friday badminton once
and it disappears from your app forever. Fixed with `app.is_regular()`, plus a
test proving the door did **not** open for anyone else.

**The admin console** ranks sports by their **best single postcode, never the
total**. "34 people in Leicester want padel" is a vanity number: spread across
five postcodes, not one of them can get a game. Football (19 in LE18) correctly
outranks padel (25 across three postcodes, best pile 12).

It immediately surfaced something real in the seed data: **running is at 18/15 in
LE2 — already over its threshold and ready to open**, and nothing else would have
told you.

---

## What I did NOT build

Being straight about the gaps:

- **Auth.** MockRepo signs you in instantly. Real sign-up needs Supabase Auth. I'd
  use **phone OTP** — the friction is worth it, because it's one account per human
  and it makes ban-evasion expensive.
- **Actually delivering a push to a phone.** The fan-out, the outbox, the worker and
  the client registration are all built and tested. What's missing is an Expo
  account and `npx expo install expo-notifications expo-device` — then swap
  `ConsoleSender` for `ExpoPushSender`.
- **The cron that fires the weekly ask.** `app.enqueue_weekly_prompts()` exists and
  is tested. It needs `pg_cron` (or a Supabase scheduled function) to call it.
- **Payments.** Deliberately. Stripe Connect, and only once people are actually
  playing.
- **Navigation library.** I hand-rolled a small navigator to keep the dependency
  tree light. Swapping to react-navigation is a contained job.

---

## Next, in the order I'd do it

1. **Supabase project + auth.** This is now the only thing standing between the
   code and real users. The data is trapped on one phone until it exists.
2. **Turn the push on for real** — Expo account, then one line.
3. **pg_cron** for the weekly ask.
4. **Payments** (Stripe Connect), and only once people are actually playing.

The scaling work is done and it was never the problem: this architecture carries
20,000 users on about £50/month, and roughly half a million before anything needs
rethinking. The thing that kills this app is still twelve people in Wigston.
