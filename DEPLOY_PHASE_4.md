# Deploy Phase 4 (backend) - step by step
Deploy backend and frontend TOGETHER (accept now requires `acceptTerms: true`, quotes require payment terms, DELIVERED requires a receiver name; the Phase 3 frontend cannot do these).
1. Back up the database (Railway snapshot). Do this before anything else.
2. Upload `agri_backend_phase4.zip` contents; leave `DB_SETUP_MODE` unset (auto) -> `prisma migrate deploy` applies `20261020100000_p4_transport_brief_testing_ref`.
   - Manual alternative (safe to re-run): `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261020100000_p4_transport_brief_testing_ref/migration.sql`.
   - `db push` databases: use `DB_SETUP_MODE=push` once; triggers/sequence come from the SQL file (the app creates the sequence itself if absent).
3. `npm ci && npx prisma generate && npm run build && npm test` (expect only the 18 `route-ordering.e2e-spec` failures unless the Prisma engine is available).
4. Smoke test on staging first: request -> quote with charges and terms -> counter -> accept (tick box) -> TRO- number -> driver -> picked up -> delivered (receiver) -> acknowledge -> invoice (check due date and PDF) -> payment -> confirm; book a lab test twice quickly (one TST- request); open `/track/<id>` logged out (masked driver, no phone/contact).
5. Check back-fill: `SELECT "requestNumber","orderNumber" FROM transport_requests WHERE "agreedPrice" IS NOT NULL;` every booked row has a TRO number.
6. Rollback: migration is additive; redeploy Phase 3 build (new columns ignored; Phase 3 frontend accept would fail only against the new backend). Do NOT drop columns/tables.
