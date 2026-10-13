#!/bin/sh
# Applies the database schema, then starts the API.
#
# DB_SETUP_MODE (optional, default "auto"):
#   auto    - `prisma migrate deploy` if prisma/migrations has migrations, otherwise `prisma db push`.
#   push    - ALWAYS `prisma db push` (brings the live database up to schema.prisma; never drops
#             data — Prisma refuses destructive changes unless told otherwise). Use this once to
#             repair "Database schema is out of date" errors, then remove the variable.
#   migrate - ALWAYS `prisma migrate deploy`.
#   skip    - do nothing (same as SKIP_DB_SETUP=true).
set -e
MODE="${DB_SETUP_MODE:-auto}"
[ "${SKIP_DB_SETUP:-}" = "true" ] && MODE="skip"

has_migrations() {
  [ -d prisma/migrations ] && [ -n "$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]
}

case "$MODE" in
  skip)
    echo "[entrypoint] database setup skipped"
    ;;
  push)
    echo "[entrypoint] DB_SETUP_MODE=push — prisma db push"
    npx prisma db push --skip-generate
    ;;
  migrate)
    echo "[entrypoint] DB_SETUP_MODE=migrate — prisma migrate deploy"
    npx prisma migrate deploy
    ;;
  auto)
    if has_migrations; then
      echo "[entrypoint] prisma migrate deploy"
      npx prisma migrate deploy
    else
      echo "[entrypoint] no migrations found — prisma db push"
      npx prisma db push --skip-generate
    fi
    ;;
  *)
    echo "[entrypoint] unknown DB_SETUP_MODE='$MODE' (use auto|push|migrate|skip)" >&2
    exit 1
    ;;
esac
exec node dist/src/main
