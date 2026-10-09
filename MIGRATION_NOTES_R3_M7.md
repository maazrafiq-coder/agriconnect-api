# Round 3 · Milestone 7 — Make delivered work real

Cumulative on top of M1–M6 and M8. **No schema changes, no new env vars, no data migration.**
One backend behaviour fix (`releaseLien`). The frontend zip is re-issued unchanged.

## READ FIRST: what was and was not run

I could not run Docker, a real Postgres, or the real Prisma client in my sandbox (no Docker daemon,
Prisma engine downloads blocked). So:

| Item | Status |
|---|---|
| `npx jest` (unit, stubbed Prisma) | **Run, passing** |
| `npx nest build`, `tsc --noEmit` | **Run, passing** |
| `npm run lint` (new) | **Run: 0 errors, 14 warnings** |
| Integration specs `test/*.int-spec.ts` | **Written and type-checked only. NEVER executed.** |
| `Dockerfile`, `docker-compose.yml` | **Edited, never built or started** |
| `scripts/baseline-migration.sh` | **Syntax-checked (`sh -n`) only. Never run.** |
| GitHub Actions workflows | **YAML-parsed only. Never run.** |
| Strict TS against the real Prisma client | **Not run** (see section 5) |

Expect the first local/CI run of the integration specs to surface mistakes in the tests themselves
(wrong fixture fields, ordering). Treat failures there as "fix the test" first, but read each one:
some may be real bugs, which is the point of these tests.

## 1. Real bug fixed: double loan repayment on lien clearance
`WarehouseService.releaseLien` read the lien, then updated it unconditionally. Two simultaneous
clearances could both pass the check and both book a `LOAN_REPAYMENT`. It now runs in one
interactive transaction with a guarded `updateMany` (status must still be ACTIVE); the loser gets
"This lien was just cleared — refresh and check its status". Unit test added.

## 2. Migrations baseline (`npm run db:baseline`)
Until now the repo had no `prisma/migrations`; the entrypoint used `db push`. The script
creates `0_init` from the current schema and marks it applied on your existing DB without running it.

Steps (do staging first):
1. Back up: `pg_dump "$DATABASE_URL" -Fc -f backup.dump`
2. Dry run: `DATABASE_URL=<staging url> BASELINE_DRY_RUN=1 npm run db:baseline` — writes the SQL only, changes nothing. Read it.
3. Real run: `DATABASE_URL=<staging url> npm run db:baseline`. It first checks the live DB has
   no drift from `schema.prisma` and aborts if it does (fix drift, or `db push`, then retry).
4. Commit `prisma/migrations/`. Repeat on production.
5. From now on: `npm run db:migrate` locally to create migrations; deploys run `prisma migrate deploy`
   (the entrypoint switches automatically once migration folders exist).

Alternative with no local DB: run the **baseline** job in CI (workflow_dispatch, tick the box) and
download the SQL artifact; you still must run `prisma migrate resolve --applied 0_init` yourself.

**Rollback:** delete `prisma/migrations/0_init`, then `DELETE FROM _prisma_migrations WHERE migration_name='0_init';`.
Entrypoint falls back to `db push`. No application data is touched either way.

## 3. Docker
- `Dockerfile`: `prisma generate` after pruning dev deps (the client was missing from the pruned image); CRLF stripped from the entrypoint.
- `.gitattributes`: forces LF for `*.sh` and `Dockerfile` (a Windows checkout would otherwise break the container).
- `docker-compose.yml`: `.env` optional; forces `NODE_ENV=development` and the compose DB URL; safe local defaults for `JWT_SECRET`, `FRONTEND_URL`, dev OTP. Reason: the image defaults to production, which demands AWS variables and refuses the dev OTP.
Run: `docker compose up --build`.

## 4. Integration tests (real Postgres)
`test/trade-ledger.int-spec.ts` — accept → order, fee frozen at accept, counter at counter price,
counter-accept race, seller double-accept race, last-stock race, competing offers, cancel restores
stock, completion books ORDER_PAYMENT + PLATFORM_FEE exactly once, dispute resolution, ledger sums.
`test/warehouse-ledger.int-spec.ts` — booking/receipt valued from the price table, capacity race,
70% lien cap, loan apply → confirm race → one disbursement, clearance race → one repayment,
gate-out blocked while lien active, decline/reapply, insurance pricing and double-buy, invoice
payment race (storage fee + premium once), refund on cancel. Helpers: `test/helpers/integration.ts`.

Run:
```
docker compose -f docker-compose.test.yml up -d
export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/agri_test
npm run test:integration:setup && npm run test:integration
```
The setup script does `db push --force-reset` — it **wipes** whatever TEST_DATABASE_URL points at. Never point it at a real DB.

## 5. Lint and strict TypeScript
- ESLint added to the backend (`.eslintrc.json`, `npm run lint`); noisy rules relaxed on purpose.
- `tsconfig.strict.json` + `npm run typecheck:strict` enable `noImplicitAny` and `strictNullChecks`
  **without touching the main tsconfig**. Fixed: spec args, `auth.service` index typing, new-test params.
  Remaining in my sandbox: **38 errors, all TS7006** (callback / `tx` params in `warehouse`, `products`,
  `offers`, `categories`, `users`, etc.). With the real generated client many `$transaction(async tx => …)`
  params are inferred and will vanish, but I could not confirm that. Counts may differ for you.
  CI runs it as **non-blocking**; make it blocking (and then flip the flags in `tsconfig.json`) once it is clean.

## 6. CI (`.github/workflows/ci.yml`, one per repo — backend and frontend are separate repos here)
Backend: install → `prisma generate` → lint → tsc → jest → integration (Postgres service) → nest build →
strict typecheck (non-blocking) → once `prisma/migrations` exists: `migrate deploy` on an empty DB plus a
drift check against `schema.prisma`. Also a Docker build job and the optional baseline-generation job.
Frontend: lint → vitest → `VITE_API_URL=… vite build`.
If you use a monorepo, move the files to the root and add `working-directory`.

## Suggested next step
M9 (health/readiness, structured logging, Sentry hooks, rate-limit review, RUNBOOK, seed refresh, npm audit) — say "go".
