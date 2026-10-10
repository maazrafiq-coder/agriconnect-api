# AgriConnect backend — operations runbook

Written from the code, not from experience running it in production. Where a step has not been
exercised on your Railway project it says so. Fix this file the first time reality differs.

## 1. Quick reference

| Thing | Where |
|---|---|
| Liveness (process up, no DB) | `GET /api/v1/health/live` |
| Readiness (200 only if DB answers, else 503) | `GET /api/v1/health/ready` |
| Legacy health (always 200, `status: degraded` if DB down) | `GET /api/v1/health` |
| Request id | every response header `X-Request-Id`; every error body `requestId`; every log line |
| Logs | stdout/stderr, one JSON object per line in production |
| API docs | `/docs` — off in production unless `ENABLE_SWAGGER=true` (+ `SWAGGER_USER/PASSWORD`) |

Point Railway's health check at `/api/v1/health/ready` (or `/live` if you'd rather a DB outage not
trigger restarts). Uptime monitor: `/health/ready`.

## 2. Required configuration (the app refuses to boot otherwise)
`FRONTEND_URL`, `DATABASE_URL`, `JWT_SECRET` (≥32 chars). In production also `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` (+ `AWS_S3_ENDPOINT` for Railway buckets).
`OTP_DEV_MODE=true` in production requires `ALLOW_INSECURE_DEV_OTP=true` (anyone can log in with 000000 — UAT only).
**Behind Railway set `TRUST_PROXY=1`.** Without it every user appears to come from the proxy's IP and
the rate limiter counts them all together (one busy minute locks everyone out of login).
Boot errors name the missing variable; read the first lines of the deploy log.

## 3. Reading logs / tracing a complaint
1. Get the `requestId` from the user's error screenshot/response, or from the `X-Request-Id` header.
2. Search the logs for that id: the access line (`method path status durationMs userId`) and any error stack share it.
3. Query strings are never logged (they can carry tokens).
Levels: `LOG_LEVEL=debug` temporarily for more detail; set back after.

## 4. Error reporting (Sentry) — optional, off by default
`npm i @sentry/node`, set `SENTRY_DSN` (and optionally `SENTRY_ENVIRONMENT`), redeploy. Only 5xx errors are
reported, with request id, method and path; cookies, auth headers and bodies are stripped.
If the DSN is set but the package is missing the app logs one warning and runs normally.

## 5. Deploys
- Image start: `scripts/docker-entrypoint.sh` runs `prisma migrate deploy` if `prisma/migrations` exists, otherwise `db push`.
- **Do the migrations baseline first** (see `MIGRATION_NOTES_R3_M7.md`) so schema changes become reviewable migrations.
- Shutdown hooks are enabled: on SIGTERM Nest drains and closes the DB connection.
- Rollback of code: redeploy the previous image. Rolling back a *migration* is manual SQL — take a `pg_dump` before any
  migration that drops/renames columns.

## 6. Backups (not automated by this repo)
Enable Railway's Postgres backups, and additionally `pg_dump "$DATABASE_URL" -Fc -f agri-$(date +%F).dump` before risky releases.
Restore: `pg_restore --clean --if-exists -d "$DATABASE_URL" file.dump` into a **new** database first and check it.
Uploaded files live in the S3/Railway bucket, not the container; back that up separately.

## 7. Money / ledger incidents
Money moves are rows in `transactions` (types: ORDER_PAYMENT, PLATFORM_FEE, STORAGE_FEE, TESTING_FEE, TRANSPORT_FEE, INSURANCE_PREMIUM, LOAN_DISBURSEMENT, LOAN_REPAYMENT, REFUND).
Each flow is guarded so a repeat/double click cannot book twice, but if a figure looks wrong:
1. Pull all `transactions` for the order/booking/lien id, ordered by `createdAt`.
2. Compare with `audit_logs` (admin actions) for the same entity.
3. Do **not** edit rows by hand without a dump; correct with a new compensating row and note why in the audit log.

## 8. Common problems
| Symptom | Likely cause / action |
|---|---|
| Users get 429 "Too Many Requests" in groups | `TRUST_PROXY` not set (see §2) |
| `P2021/P2022` "schema out of date" in responses | DB behind code: run `npx prisma migrate deploy` (or `db push` if no baseline yet) |
| Container restarts in a loop | read first boot log line: env validation error, or DB unreachable |
| Readiness 503, liveness 200 | database down/unreachable — check Railway Postgres, `DATABASE_URL` |
| Uploads fail | bucket env vars wrong; check logs for the S3 error with the request id |
| Login says "pending admin review" | expected: KYC not approved yet; approve in Admin → Registrations |

## 9. Rate limits (per IP unless noted)
Global 60/min. Register 5, resend-OTP 5, login 8, forgot-password 3, verify-otp 10 (per identifier), public stats 30,
shipment tracking 20, per minute. Health probes are exempt. Limits are in-memory per instance: with more than one
instance each has its own counters.

## 10. Known open items (see MIGRATION_NOTES_R3_M9.md)
Dependency vulnerabilities needing major upgrades; public profile endpoint scope; no automated backups; no SMS provider.
