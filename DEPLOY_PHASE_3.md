# Deploy Phase 3 (backend) - step by step
Deploy backend and frontend TOGETHER (accept now requires `roundId`; the old frontend cannot accept quotes on the new backend).
1. Back up the database (Railway snapshot).
2. Upload `agri_backend_phase3.zip` contents; keep `DB_SETUP_MODE` unset (auto) -> `prisma migrate deploy` applies `20261019100000_p3_transport_lifecycle`.
   - If the DB was created with `db push` and has no `_prisma_migrations` history, use `DB_SETUP_MODE=push` once, OR run the SQL by hand: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261019100000_p3_transport_lifecycle/migration.sql` (safe to re-run).
3. `npm ci && npx prisma generate && npm run build && npm test` (expect only the 18 `route-ordering.e2e-spec` failures unless the Prisma engine is available).
4. Smoke test (staging): buyer creates request -> TRQ-… reference; transporter quotes; buyer counters; transporter accepts; add driver + plate; mark picked up/in transit/delivered; open `/track/<id>` logged out (masked driver, no phone); buyer acknowledges; transporter issues invoice, downloads PDF; buyer submits payment; transporter confirms; raise + respond + admin-resolve a dispute on a second shipment.
5. Rollback: the migration is additive; redeploy the Phase 2 build (new columns/tables are ignored). Do NOT drop tables.
