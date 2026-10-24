# Phase 1 — Deploy & test (step by step)

Order matters: **back up → backend (Railway) → verify → frontend (Vercel)**. Nothing here drops data.

## 0. Back up the database
Railway → your Postgres service → Data/Backups → create a backup, **or** from your computer:
`pg_dump "$DATABASE_PUBLIC_URL" -Fc -f agri_before_phase1.dump`
(Keep the URL secret; don't paste it in chats.)

## 1. Backend (Railway)
1. Unzip `agri_backend_phase1.zip` over your backend repo (it is cumulative; delete nothing). Commit and push to the branch Railway deploys. Prefer staging first if you have it.
2. Schema: check Railway → backend service → Variables for `DB_SETUP_MODE`.
   - **Unset/`auto`** and the DB was baselined with `0_init` (a `_prisma_migrations` table exists): the container runs `prisma migrate deploy` and applies the new migration automatically. Nothing to do.
   - If the logs show `P3005 database schema is not empty` (DB was created with `db push` and never baselined): set `DB_SETUP_MODE=push` and redeploy (adds the table/column, drops nothing), **then** run the back-fill once:
     `psql "$DATABASE_PUBLIC_URL" -f prisma/migrations/20261017100000_p1_clarification_thread/migration.sql` (safe to re-run; NOTICEs "already exists, skipping" are normal).
3. Watch deploy logs for `[entrypoint]` lines, then `Nest application successfully started`. Health: `GET https://<backend>/api/v1/health/live` → 200.
4. Quick DB check (optional): `select count(*) from review_clarification_messages;` → ≥ number of existing clarifications.

## 2. Frontend (Vercel)
Unzip `agri_frontend_phase1.zip` over the frontend repo, commit, push. Vercel builds automatically (`npm run build`). No new env vars. Hard-refresh after deploy.

## 3. Test checklist (use test accounts, not real customers)
**A. Pending / submitted user (browse but not transact)**
1. Register a new user and verify OTP; submit KYC. Log in → you land on the account/marketplace (no "not approved" login error).
2. A yellow status banner shows your KYC state. Open Marketplace and a product: browsing works.
3. Click "Make offer" / "Book lab test" / "Book warehouse" / "New listing": an **"Approval needed"** dialog appears; no request is sent.
4. Direct API check (optional): `POST /api/v1/offers` with that user's token → **403**.
5. Rejected user: log in → read-only session, rejection reason visible in Account; no transactions.
6. Suspended user (`isActive=false`): login still refused.

**B. Clarification thread (the original bug)**
1. As admin, open that user's KYC → "Request information" with a message.
2. As the user: bell notification → opens Account on the clarification (highlighted). Reply once with text (+ a file). It appears immediately as **You** with "✓ Sent"; you stay logged in; no authorization error.
3. Double-click Send quickly: only one message. Send a second reply: both visible, in order.
4. Simulate offline (browser devtools → Offline) and send: error shown, your text is kept; go online, Send again → one message only.
5. As admin: bell shows the user's reply and opens the user KYC (`/admin?tab=users&type=kyc&id=…`). Reply again → user is moved back to INFO_REQUESTED and notified.
6. Resolve it → thread is read-only; shows under "Earlier verification conversations".

**C. Notification links**
Make an offer as buyer → seller bell opens `Seller → Offers` with that offer highlighted. Seller declines → buyer bell opens `Buyer → Offers` at that offer. Delete/withdraw the record and click the old notification: a notice "no longer available" appears instead of a blank page. A notification with no page says so.

**D. Dialogs (no native browser popups anywhere)**
Order status change (Confirm delivery / Complete), cancel transport request, remove media, delete listing, remove commodity price, accept/decline counter, withdraw offer, warehouse: confirm payment (optional reference), request gate-out, approve/reject release (reason), withdraw loan application. Each shows an in-app dialog, a busy state, an error on failure, and closes only on success.

**E. Regression**: login/logout/refresh, approved buyer places an offer, seller counters, order flow, warehouse booking, admin KYC approve.

## 4. Rollback
- Frontend: Vercel → Deployments → promote the previous deployment.
- Backend: Railway → Deployments → redeploy the previous one. The added table/column are unused by old code, so **no DB rollback is needed**. (Only if you must: restore `agri_before_phase1.dump`.)

## 5. Run what I couldn't run (on your machine, optional but recommended)
```
cd backend && npm ci && npx prisma generate
docker compose -f docker-compose.test.yml up -d
npm test                      # unit (should be fully green with a real Prisma engine)
npm run test:integration
```
Report any failure back in the new chat with the output.
