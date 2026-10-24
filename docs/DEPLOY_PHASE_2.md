# Phase 2 — Deploy & test (step by step)

Order: **back up → backend (Railway) → verify DB → frontend (Vercel) → test**. Nothing here drops data. Deploy backend first: the new frontend calls the new routes.

## 0. Back up
`pg_dump "$DATABASE_PUBLIC_URL" -Fc -f agri_before_phase2.dump` (keep the URL secret) or a Railway backup.

## 1. Backend (Railway)
1. Unzip `agri_backend_phase2.zip` over the backend repo (cumulative; delete nothing), commit, push (staging first if you have one).
2. Migration `20261018100000_p2_offer_rounds_terms_invoices`:
   - `DB_SETUP_MODE` unset/`auto` and DB baselined: `prisma migrate deploy` applies it automatically.
   - Created with `db push` (P3005 in logs): set `DB_SETUP_MODE=push`, redeploy, **then run the SQL once by hand** — `db push` cannot create the partial unique indexes, the trigger or the back-fill:
     `psql "$DATABASE_PUBLIC_URL" -f prisma/migrations/20261018100000_p2_offer_rounds_terms_invoices/migration.sql`
     (re-runnable; “already exists, skipping” notices are normal).
3. Logs: `[entrypoint]` lines then `Nest application successfully started`; `GET /api/v1/health/live` → 200.
4. Verify in SQL:
   - `select count(*) from offer_rounds;` ≥ number of existing offers.
   - `select indexname from pg_indexes where indexname in ('offer_rounds_one_current_per_offer','seller_invoices_one_live_per_order');` → 2 rows.
   - `select tgname from pg_trigger where tgname='orders_terms_snapshot_immutable_trg';` → 1 row.
   - `select count(*) from offers o where o."currentRoundId" is null and o.status in ('PENDING','COUNTERED');` → 0.

## 2. Frontend (Vercel)
Unzip `agri_frontend_phase2.zip` over the frontend repo, commit, push. No new env vars. Hard-refresh.

## 3. Test checklist (test accounts only)
**A. Listing** — Seller → New Listing: fill form → Review shows terms → Create. Edit it, change terms, save.
**B. Offer** — Buyer → product → Make an Offer: pick *Credit 30 days* → Review → untick agreement → Send is refused; tick → sent, shows reference. Seller bell opens Offers at that offer.
**C. Rounds** — Seller counters with different price and *Partial advance 30%*. Buyer bell → Offers: sees counter, timeline lists both rounds with changes. Buyer “Counter back”; seller sees it. Old round is no longer actionable (stale → error message, not a crash).
**D. Accept** — Accept review shows price/qty/total/terms. Seller view shows platform fee and “You receive”; buyer view does **not**. Accept is blocked until the terms box is ticked. Order appears with the frozen terms and schedule.
**E. Concurrency** — Open the same offer in two browsers (seller) and accept in both at nearly the same time: exactly one order is created; the other shows an error.
**F. Terms immutability** — in SQL: `update orders set "paymentTermsSnapshot"='{}' where id='<order>';` must fail (trigger).
**G. Invoice** — Seller order → Details → Issue invoice: number `SINV-…`, buyer notified (bell opens Buyer → Orders at the invoice). Buyer sees full amount, **no** fee/net, PDF opens and has no fee text. Issue again → refused (one live invoice). Buyer “submit payment” without a reference is refused; with one → status Payment submitted. Seller “Not received” → back to awaiting payment with the reason; submit again; seller “Confirm payment received” → Paid and order marked paid. Void / Replace create a new number; the old one shows Void.
**H. Cancel** — cancel an order that has an open invoice → invoice becomes Void.
**I. Legacy** — an offer made before this release still lists, can be countered/accepted; its terms read “Not specified…”.

## Rollback
Frontend: redeploy the previous Vercel build. Backend: redeploy the previous image — the migration is additive (new tables/columns/trigger), old code ignores them. Do not drop the new tables.
