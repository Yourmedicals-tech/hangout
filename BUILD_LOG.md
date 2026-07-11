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
| `packages/db/test/security.test.js` | **33** | A non-member of a game cannot read the venue, the court, the roster or the chat. Zero rows — not a filtered answer. |
| `packages/db/test/race.test.js` | **16** | 10 people tapping "I'm in" on a 1-spot game → exactly 1 gets in. And the naive version double-books, so the lock is doing work. |
| `packages/shared/test/domain.test.ts` | **20** | Money, player counts, reliability, density, the ladder. |
| `packages/shared/test/mock-repo.test.ts` | **18** | The mock is *no more permissive than Postgres*. |
| Expo app (browser-driven) | **23** | The ladder is visible on screen: a stranger genuinely cannot read "Active Wigston" anywhere. |

**110 checks. All passing.**

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

## What I did NOT build

Being straight about the gaps:

- **Auth.** MockRepo signs you in instantly. Real sign-up needs Supabase Auth. I'd
  use **phone OTP** — the friction is worth it, because it's one account per human
  and it makes ban-evasion expensive.
- **Push notifications.** The core loop *is* the push. Needs Expo Notifications +
  a real device + a Supabase Edge Function to fan out on "someone dropped out".
  This is the single most important thing to build next.
- **The admin console.** The schema is there (`sport_requests`, `admin_demand`,
  ranked by best *area* not total). No screen yet.
- **Weekly "are you in?" prompts** for recurring games. Tables exist
  (`game_regulars`, `game_absences`); the cron job doesn't.
- **Payments.** Deliberately. Stripe Connect, and only once people are actually
  playing.
- **Navigation library.** I hand-rolled a small navigator to keep the dependency
  tree light. Swapping to react-navigation is a contained job.

---

## Next, in the order I'd do it

1. **Push notifications.** Without them there is no product — the whole thing is
   "somebody dropped out, and forty people found out in ten seconds."
2. **Supabase project + auth**, so the data is shared rather than trapped on one phone.
3. **The weekly in/out prompt.** Most real sport is a standing fixture.
4. **Admin console** on the existing schema.

The scaling work is done and it was never the problem: this architecture carries
20,000 users on about £50/month, and roughly half a million before anything needs
rethinking. The thing that kills this app is still twelve people in Wigston.
