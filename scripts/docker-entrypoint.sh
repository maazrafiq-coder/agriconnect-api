#!/bin/sh
# Applies the database schema, then starts the API.
#  - If prisma/migrations contains migrations: `prisma migrate deploy` (safe, versioned).
#  - Otherwise (before the baseline has been created): `prisma db push`, the
#    behaviour this project has used so far. Create the baseline once with
#    scripts/baseline-migration.sh and commit it to switch over.
set -e
if [ "${SKIP_DB_SETUP:-}" != "true" ]; then
  if [ -d prisma/migrations ] && [ -n "$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]; then
    echo "[entrypoint] prisma migrate deploy"
    npx prisma migrate deploy
  else
    echo "[entrypoint] no migrations found — prisma db push"
    npx prisma db push --skip-generate
  fi
fi
exec node dist/src/main
