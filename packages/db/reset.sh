#!/usr/bin/env bash
# Drop, recreate, migrate, seed. Idempotent — run it as often as you like.
set -euo pipefail

DB=${DB:-hangout}
CONTAINER=${CONTAINER:-hangout-db}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

psql_run() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

echo "→ recreating database '$DB'"
psql_run -d postgres -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);"
psql_run -d postgres -q -c "CREATE DATABASE $DB;"

for f in "$HERE"/migrations/*.sql; do
  echo "→ $(basename "$f")"
  psql_run -d "$DB" -q < "$f"
done

echo "→ seed.sql"
psql_run -d "$DB" -q < "$HERE/seed/seed.sql"

echo
echo "✓ database ready"
psql_run -d "$DB" -tc "
  select '  ' || rpad(relname, 22) || lpad(n_live_tup::text, 5) || ' rows'
  from pg_stat_user_tables
  where schemaname='public' and n_live_tup > 0
  order by relname;"
