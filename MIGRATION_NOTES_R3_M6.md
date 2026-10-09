# Round 3 · Milestone 6 — Engineering foundations

## Database
Run `prisma db push` once (or `migrate` after baselining). Only **indexes** changed — no columns, no data impact:
- Added: Offer(buyerId,status), Offer(status,expiresAt), Order(sellerId,status), Order(buyerId,status), Product(sellerId,status), TestingRequest(agencyId|requesterId,status), TransportRequest(providerId|requesterId,status), WarehouseReceipt(ownerId,status), AuditLog(entityType,entityId), AuditLog(userId,createdAt).
- Removed redundant: User(phoneNumber), User(email) (already `@unique`), Notification(userId) and Notification(isRead) (covered by the existing (userId,isRead,createdAt)).

## Migrations baseline (one-time, run by you)
Prisma's engine download is blocked in my sandbox, so I could not generate or verify the SQL — I did not hand-write 40+ tables unverified. Instead:
```
# DATABASE_URL = existing DB created by `db push` (take a backup first)
npm run db:baseline      # writes prisma/migrations/0_init, marks it applied
git add prisma/migrations
```
Afterwards use `npx prisma migrate dev --name <change>` locally and `npm run db:deploy` in production. The Docker entrypoint uses `migrate deploy` once migrations exist, and `db push` before that.

## Docker
`Dockerfile` (multi-stage, non-root, tini), `.dockerignore`, `docker-compose.yml` (API + Postgres), `scripts/docker-entrypoint.sh`. Not built in my sandbox (no Docker daemon) — first `docker build` is its first real run.

## Tests
- Backend unit: 380 passing (unchanged).
- New real-Postgres integration test (`test/transport.int-spec.ts`, transport lifecycle + double-accept race + no re-quote after acceptance). Skipped unless `TEST_DATABASE_URL` is set; **not run in my sandbox** (no Postgres). Run: `docker compose -f docker-compose.test.yml up -d`, `export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/agri_test`, `npm run test:integration:setup && npm run test:integration`.
- Frontend: Vitest + Testing Library, 16 tests (adapters, API client refresh/error handling, shared UI, ProductCard). `npm test`.

## TypeScript
Enabled (0 errors): `strictBindCallApply`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `noImplicitThis`, `useUnknownInCatchVariables`. NOT enabled: `noImplicitAny` / `strictNullChecks` — my sandbox uses a Prisma stub, so their error counts there (45 / 2) don't match what the real generated client would produce. Turn them on locally with `npm run typecheck` after `prisma generate` and fix what appears.

## Frontend
- `lib/config.js`: single API base; a production build without `VITE_API_URL` shows a configuration error instead of calling localhost.
- Shared `Btn` / `Modal` now cover WarehousePage's needs; its private copies of Btn/Card/Modal are gone. `Btn` defaults to `type="button"` and passes through props (e.g. `title`).
- A11y: dialogs have `role="dialog"`, a label, an accessible Close button and close on Escape; product cards are keyboard-reachable links.
- ESLint (`npm run lint`) added; zero undefined references / hook-rule errors.
- Not done: splitting the largest page files (WarehousePage, AdminDashboard, SellerDashboard) — I didn't want to ship a large unverifiable refactor. Lint now makes that safe to do next.
