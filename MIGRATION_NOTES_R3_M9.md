# Round 3 · Milestone 9 — Operational readiness

Backend-only. **No schema change, no data migration, no new required env vars.** Frontend zip re-issued unchanged.
Cumulative on M1–M8. New operator doc: `RUNBOOK.md`.

## READ FIRST
- **Set `TRUST_PROXY=1` on Railway when you deploy this.** Not done by default (it would be wrong for a
  directly exposed server). Until set, behaviour is exactly as before: behind Railway all users share the
  proxy IP, so the rate limiter (login 8/min, etc.) counts everyone together. I could not observe your
  Railway topology; if you also have a CDN/proxy in front of Railway the hop count is 2 — verify by
  checking a logged client IP.
- `package-lock.json` changed (non-breaking `npm audit fix`). Run `npm ci` after pulling.
- Not run here: Docker (new `HEALTHCHECK`), real Postgres, Sentry, Railway. Everything below was verified
  by unit tests, build and lint only.

## 1. Health / readiness
`GET /health/live` (no DB, never throttled), `GET /health/ready` (DB `SELECT 1` bounded at 3 s → 200, else **503**),
`/health` unchanged (always 200, `degraded`) so existing monitors keep working. Probes are exempt from rate limiting.
Dockerfile `HEALTHCHECK` hits `/health/live` (liveness only, so a DB outage doesn't make Docker kill the app).

## 2. Logging with request ids
- Every request gets an id (inbound `X-Request-Id` kept only if it matches `[A-Za-z0-9._-]{8,64}`), returned in the
  `X-Request-Id` response header (CORS-exposed), included in error bodies as `requestId`, and on every log line.
- One access line per request: method, path **without query string**, status, ms, user id. Successful health probes are not logged.
- JSON lines in production, readable text otherwise. `LOG_LEVEL`, `LOG_FORMAT` env. Nest's own logger now routes through it.
- 5xx stack traces are logged with the path minus query string.
- New env (all optional): `TRUST_PROXY`, `LOG_LEVEL`, `LOG_FORMAT`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`.

## 3. Sentry hook (off by default)
Nothing loads unless `SENTRY_DSN` is set. `@sentry/node` is **not** added as a dependency; to enable: `npm i @sentry/node`.
Reports 5xx only; strips cookies, auth header, request body. **Untested against real Sentry.**

## 4. Rate-limit and exposure review
- **Public route allowlist is now a test** (`src/__route-audit__/public-routes.spec.ts`): reads the real decorator
  metadata and fails if any route is reachable without a login guard that isn't on the allowlist. Result of the review:
  no accidentally open route; 27 deliberate public routes (auth flow, file-token downloads, marketplace browsing, tracking, probes).
- **Shipment tracking** (`GET /transport/track/:id`): ids are random UUIDs; now limited to 20/min/IP. It returns status,
  current location, ETA, **driver name**, pickup/delivery city, timestamps and the provider's tracking URL — **no phone, price, buyer or order data**.
  Anyone holding the link sees the driver's name; say if you want that removed.
- **`GET /users/:id` (public profile)** returns name, business, city, province, photo, crops, rating comments, counts — no phone/email/CNIC.
  It does not check account status, so a pending/deactivated user's profile is readable by id. I did **not** change this (behaviour change); say if you want it restricted.
- `GET /warehouse/:id/quote` is public (read-only rate preview) under the global 60/min limit.
- Limits are in-memory per instance; with >1 instance they are not shared (needs a Redis store — not done).

## 5. npm audit (production deps)
Before: 22 vulnerabilities (2 critical, 11 high). Applied **only** non-breaking fixes (lockfile only, `package.json` untouched):
this cleared the critical `proxy-addr` IP-spoofing issue (relevant to the rate limiter), plus `joi`, `compression`, `qs`, `brace-expansion`, `@nestjs/common`.
After: 18 (1 critical, 8 high, 8 moderate, 1 low) in production deps. The remainder need **major upgrades**, left for you to schedule:
| Package | Why it remains | Practical risk |
|---|---|---|
| `bcrypt` 5→6 (critical `tar`) | `tar` is used by bcrypt's *install-time* downloader | install-time only, not at runtime |
| `multer` 1→2, `@nestjs/platform-express`, `@nestjs/core`, `@nestjs/serve-static`, `@nestjs/swagger`, `@nestjs/config`, `@nestjs/throttler` | require Nest 10→11/12 | DoS-class issues in upload/routing; upgrade Nest as its own milestone |
| `uuid`, `file-type` | major bumps | low |
Recommendation: a dedicated "Nest upgrade" milestone with the integration tests green first. Dev-only deps not addressed.

## 6. Seed refresh
Added a demo **moderator** (`0300-6666666` / `Moderator@123`) and an explicit `platform_fee_pct = 1.5` setting row
(`update: {}`, so an admin's edit is never overwritten). The seed still refuses to run in production. **Not executed** (no DB here).

## 7. RUNBOOK.md
Probes, config, tracing a complaint by request id, Sentry, deploy/rollback, backups, money-incident procedure, common symptoms, rate limits.
It is written from the code; no step has been exercised on your Railway project.

## Verification (run here)
`npx jest`: **392 passed (37 suites)** (+11: health 4, logging 6, public-route audit 1). `npx nest build` OK. `npm run lint`: 0 errors, 14 warnings (unchanged).

## NOT verified
Docker `HEALTHCHECK`; behaviour behind a real proxy; Sentry; the seed; that `TRUST_PROXY=1` is the right hop count for your setup;
log volume/cost on Railway.

## Next
All nine Round-3 milestones are now delivered. Suggested follow-ups: run M7's integration tests and baseline for real, then a Nest-upgrade milestone.
