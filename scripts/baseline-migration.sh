#!/bin/sh
# One-time: turn the current schema into the first Prisma migration ("0_init")
# and mark it as ALREADY APPLIED on your existing database — without changing
# that database.
#
# Run from the backend root with DATABASE_URL pointing at the database that
# was created by `prisma db push` (staging first, then production), AFTER
# taking a backup. See MIGRATION_NOTES_R3_M7.md for the full steps + rollback.
#
#   sh scripts/baseline-migration.sh                 # generate, verify, mark applied
#   BASELINE_DRY_RUN=1 sh scripts/baseline-migration.sh   # only write the SQL; touch nothing
#
# Safety checks it performs before marking anything as applied:
#   1. DATABASE_URL is set and reachable.
#   2. The live database already MATCHES prisma/schema.prisma (no drift).
#      If it doesn't, baselining would record a migration that isn't true.
#   3. The generated SQL creates a table for every model in the schema.
set -e
: "${DATABASE_URL:?DATABASE_URL must point at the database created by db push}"

DIR=prisma/migrations/0_init
if [ -d "$DIR" ]; then echo "$DIR already exists — nothing to do."; exit 0; fi

if [ -z "${BASELINE_DRY_RUN:-}" ]; then
  echo "[1/4] Checking the live database matches prisma/schema.prisma …"
  set +e
  npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code > /tmp/baseline-drift.txt 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 2 ]; then
    echo "ERROR: the database differs from schema.prisma. Run 'npx prisma db push' (after a backup) so they match, then re-run."
    echo "Differences:"; cat /tmp/baseline-drift.txt
    exit 1
  elif [ "$rc" -ne 0 ]; then
    echo "ERROR: could not compare with the database (rc=$rc):"; cat /tmp/baseline-drift.txt
    exit 1
  fi
fi

echo "[2/4] Generating $DIR/migration.sql from the schema …"
mkdir -p "$DIR"
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > "$DIR/migration.sql"

models=$(grep -c '^model ' prisma/schema.prisma)
tables=$(grep -c '^CREATE TABLE' "$DIR/migration.sql" || true)
echo "[3/4] Schema has $models models; SQL creates $tables tables ($(wc -l < "$DIR/migration.sql") lines)."
# (implicit many-to-many relations add extra "_AToB" tables, so more tables than models is fine)
if [ "$tables" -lt "$models" ]; then
  echo "ERROR: the SQL creates fewer tables than the schema has models — review $DIR/migration.sql."; rm -rf "$DIR"; exit 1
fi

if [ -n "${BASELINE_DRY_RUN:-}" ]; then
  echo "Dry run: wrote $DIR/migration.sql only. Review it, then re-run without BASELINE_DRY_RUN."; exit 0
fi

echo "[4/4] Marking 0_init as applied (records it in _prisma_migrations; no schema change) …"
npx prisma migrate resolve --applied 0_init
echo "Done. Review $DIR/migration.sql and commit prisma/migrations/."
