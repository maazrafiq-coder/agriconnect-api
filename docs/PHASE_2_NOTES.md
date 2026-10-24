# Phase 2 — Negotiation, payment terms, seller invoice (R4, R7)

## What changed
**Negotiation (`OfferRound`)**
- Every offer is now a chain of rounds (proposer BUYER/SELLER, price, quantity, payment terms, message, status). Exactly one round is `CURRENT` per offer: a partial unique index (`offer_rounds_one_current_per_offer`) plus a `SELECT … FOR UPDATE` on the offer row.
- The party who did **not** propose the current round may accept, decline or counter. Acting on a stale round id → 409.
- Accept runs in one transaction under the row lock → at most one `Order` (concurrent accepts: one wins, the other gets 409/“no current round”).
- Statuses: CURRENT, SUPERSEDED, ACCEPTED, DECLINED, WITHDRAWN, EXPIRED. Expiry sweeps close rounds too.
- Legacy `Offer.counterPrice/counterMessage/status/quantity` columns are kept and mirrored from the rounds so old readers keep working. Migration back-fills round 1 (buyer’s offer) and round 2 (seller counter) deterministically, re-runnably.
- New routes: `POST /offers/:id/rounds`, `GET /offers/:id/rounds`, `POST /offers/terms/preview`; `accept` / `accept-counter` take `{acceptTerms:true, roundId}`. Create/counter/propose honour `Idempotency-Key`.

**Payment terms**
- JSON shape in `src/offers/terms/payment-terms.ts`: FULL_ADVANCE | COD | CREDIT (30/60/90/custom 1–365) | PARTIAL_ADVANCE (% or amount, balance due ON_DELIVERY / ON_ACKNOWLEDGEMENT / CREDIT) | OTHER (description). Normalised + validated server side; due-date calculator (`computeSchedule`, `finalDueDate`).
- Credit clock starts at **delivery acknowledgement** (buyer’s IN_TRANSIT→DELIVERED) unless the round says `INVOICE_DATE` (D3).
- Optional on `Product` (listing default). Every round carries its own terms.
- On accept the terms are frozen into `Order.paymentTermsSnapshot` (+ `unitPrice`, `quantity`, `acceptedRoundId`, `termsAcceptedAt/ById`). A DB trigger refuses edits once set; no service code writes it again.
- The buyer must tick “I accept these payment terms” on offer creation **and** on every accept (server enforces `acceptTerms === true`).

**Seller invoice (`SellerInvoice`)**
- Number `SINV-YYYY-000001`; one non-VOID invoice per order (partial unique index + order row lock).
- ISSUED → PAYMENT_SUBMITTED (buyer gives reference) → PAYMENT_CONFIRMED (seller). Seller can send a submitted payment back to ISSUED (“not received”), void, or replace (void + reissue, version+1). Confirming sets `order.paymentStatus = PAID`. Cancelling an order voids open invoices.
- D5: invoice amount = full order amount owed by the buyer. Platform fee / seller net appear only in the seller’s `sellerSettlement` section; buyer responses and the PDF never contain them.
- PDF built with the existing pdfkit util, uploaded to storage; regenerated lazily if the upload had failed. Notifications use `destination(...)` (`?tab=orders&type=invoice&id=`), all actions are audited.
- All mutating invoice routes use `@RequireApproved()`; `docs/PERMISSIONS_MATRIX.md` regenerated.

**Frontend**
- `MakeOfferFlow` (form → review → sent), `ProposeRoundFlow` (counter / counter back), `AcceptRoundDialog` (terms + fee/net for sellers only + explicit checkbox), `NegotiationTimeline`, `PaymentTermsEditor/View`, `OrderTermsAndInvoices` (buyer + seller invoice panel). `NewListingModal` is now form → review → saved and can carry listing payment terms. The old `CounterOfferModal` was removed.
- API names for seller invoices are `apiSale…` (`apiSaleGetInvoice`, `apiSaleGetMyInvoices`, `apiSaleConfirmInvoicePayment`) because the warehouse invoice APIs already own the plain names.

## Behaviours worth knowing
- Legacy offers/rounds have no terms; if accepted they snapshot as OTHER: “Not specified - this offer was made before payment terms were introduced”.
- The fee % on the seller’s accept screen is an estimate; the % in force at acceptance is what gets frozen.
- Unticking listing terms on an existing listing that already has terms is not allowed (checkbox locked); there is no “clear terms” action yet.
- Installment-level payment tracking (per-instalment paid/unpaid) is out of scope: one invoice, one payment confirmation.

## Test status (honest)
| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.build.json` | pass (but Prisma types are shimmed → weak) |
| Backend jest (unit) | 557 pass, 1 skipped, **18 fail** — all in `route-ordering.e2e-spec` (needs a real Prisma engine; same as Phase 1; **not run**) |
| New backend specs | payment-terms 27, offers.service + notifications 46 (incl. 3 concurrency tests on a serialised in-memory Prisma double), seller-invoice 20, permissions-matrix/public-routes/auth-hardening pass |
| Migration on real Postgres 16 | back-fill of 6 legacy cases correct + idempotent; duplicate CURRENT round and duplicate live invoice rejected; trigger blocks editing/clearing the snapshot; two-session `FOR UPDATE` race → exactly 1 order |
| Frontend vitest | 113/113 pass (19 files) |
| Frontend `vite build` | pass |
| **Not run** | `test/*.int-spec.ts` (need Postgres :5433 + Prisma engine); route-ordering e2e; the Prisma client was never generated so Prisma calls are exercised only against the fake DB; **no browser/manual UI test** — use the checklist in DEPLOY_PHASE_2.md |
| Weak spots | `NegotiationTimeline` and `PaymentTermsEditor` tests are shallow (render-level) |
