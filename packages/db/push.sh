#!/usr/bin/env bash
# Push the schema to a real Supabase project.
#
#   PGPASSWORD=... PGHOST=... PGUSER=... ./packages/db/push.sh
#
# Unlike reset.sh this NEVER drops anything. Migrations are additive and
# idempotent-ish; run it again after adding one.
#
# It seeds REFERENCE data only — areas, sports, venues. Not the demo people.
# Tom and Priya are fixtures for tests; a production database with fake users
# in it is a production database you can't trust the numbers in. And 011 adds a
# foreign key to auth.users, so fake profiles would be rejected anyway.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ target: ${PGHOST}"
psql -v ON_ERROR_STOP=1 -qc "select 1" >/dev/null
echo "  connected"

for f in "$HERE"/migrations/*.sql; do
  printf "→ %s" "$(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
  echo "  ok"
done

echo "→ reference data (areas, sports, venues — no demo people)"
psql -v ON_ERROR_STOP=1 -q <<SQL
$(sed -n '/^-- ---------------------------------------------------------------- areas/,/^-- ---------------------------------------------------------------- people/p' \
   "$HERE/seed/seed.sql" | sed '$d')
SQL

echo
psql -qtc "
  select '  ' || rpad(relname, 16) || lpad(n_live_tup::text, 5) || ' rows'
    from pg_stat_user_tables
   where schemaname='public' and n_live_tup > 0
   order by relname;"
