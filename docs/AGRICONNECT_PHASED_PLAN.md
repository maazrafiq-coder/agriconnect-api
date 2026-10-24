# AgriConnect — Phased Implementation Plan & Handoff

Status: **PLAN ONLY — no code changed yet.** Baseline = `Agri_Backend.zip` + `Agri_Frontend.zip` as uploaded 2026-10-17.
Paste this file at the top of any new chat together with the latest cumulative zips and the original brief (`attachment.txt`).

## 0. Baseline facts (verified in the code)

Backend: NestJS 10 / Prisma 5 / Postgres, ~164 files, 1,336-line schema. Jest unit tests beside services + `test/*.int-spec.ts` integration tests (Postgres on :5433 via `docker-compose.test.yml`). Deploy: Docker on Railway; entrypoint runs `prisma migrate deploy` if `prisma/migrations` exists, else `db push`. Migrations folder currently holds only `0_init` (baseline) — see decision D1.
Frontend: React 18 / Vite 5 / vitest. Plain `fetch` client in `src/lib/api.js` (in-memory access token, httpOnly refresh cookie). Vercel.

### Root causes found
| # | Issue | Root cause (file) |
|---|---|---|
| R1 | Clarification reply "authorization error" on 2nd click; reply not shown as sent | `review.service.respondToClarification` sets `User.kycStatus = SUBMITTED` on the first reply. `jwt.strategy.ts` only allows `APPROVED`/`INFO_REQUESTED` sessions, so the very next request (double-click, or the reload the UI does right after) gets 401. `apiRespondToClarification` uses raw `fetch` (no refresh/401 handling, no idempotency). Data model is one `responseMessage` per clarification (a second reply overwrites the first), so there is no true thread. |
| R2 | Pending users can't browse while waiting | `auth.service.login` returns 403 for PENDING/SUBMITTED/RECOMMENDED/REJECTED; `JwtStrategy` rejects the same states. Transaction gating exists only where `@RequireApproved()` is applied (products, warehouse, testing, transport) plus an in-service check in offers. `offers.controller` and `orders.controller` use plain `JwtAuthGuard`. |
| R3 | Declined-offer notification goes nowhere | Notifications store only a coarse `data.link` (`/buyer`, `/seller`, …) plus an id; `NotificationBell` just `navigate(link)`. No tab, no id handling, the dashboards ignore the ids. |
| R4 | Only one counter-offer | `Offer.counterPrice/counterMessage` are single columns; `OfferStatus.COUNTERED` is terminal for the seller side. |
| R5 | Native dialogs | 12+ `window.confirm/prompt` sites (OrderActions, TransportRequestCard, BuyerDashboard ×2, WarehouseOperatorDashboard ×2, WarehousePage, AdminPricingPanel, MediaManager, SellerListingsTab) plus many `alert()` calls in admin panels. |
| R6 | Transport has no negotiation / order ref / invoice / ack | `TransportRequest` has a single `quotedPrice`; statuses REQUESTED→QUOTED→BOOKED→PICKED_UP→IN_TRANSIT→DELIVERED→CANCELLED; no counter, no reference, no invoice, no acknowledgement. Public `GET /transport/track/:id` is unauthenticated (driver phone exposure — decision D4). |
| R7 | No payment terms, no seller invoice | `Product`/`Offer`/`Order` have no terms; invoices exist only for warehouse (`WarehouseInvoice`). |

## 1. Phases (each ends with cumulative zips + deploy + test steps + updated handoff)

### Phase 1 — Foundations + access control + communication (R1, R2, R3, R5 partial)
Backend
- Allow sessions for all non-suspended KYC states; introduce a read-only “limited session” rule: every state-changing marketplace/transaction route moves to `@RequireApproved()` (offers, orders, transport, testing, loans, listings); offers' in-service check kept as defence in depth.
- Login returns a normal session for PENDING/SUBMITTED/RECOMMENDED/REJECTED with `kycStatus`, rejection note and next steps; suspended (`isActive=false`) still blocked. Registration-token / OTP sequence unchanged.
- Clarification conversation: new `ReviewClarificationMessage` model (sender, role, body, attachments, `clientRequestId` unique for idempotency); backfill existing `requestMessage`/`responseMessage` into messages; respond endpoint idempotent and no longer breaks the session; status transitions enforced.
- Notifications: structured `data` contract `{ route, tab, entityType, entityId }` added alongside legacy `link`; all existing `notify()` call sites updated; fallback endpoint for deleted/inaccessible entities.
- Permissions matrix doc + automated test that walks every controller route and asserts its guard.
Frontend
- Reusable `RequestFlowModal` (form → review → success, Done, double-submit lock, focus management), `ConfirmDialog`, shared `InfoRow`; refactor `BookingModal` onto it without changing behaviour.
- Account/KYC status banner, restricted-action gating component, pending-user marketplace browsing.
- `ClarificationThread` rewritten as chronological thread with send-lock, optimistic-after-confirm display, idempotency key, distinct 401/403/network errors.
- `NotificationBell` deep links + resolver + mark-read retry; dashboards read `?tab=&id=`.
- Replace native dialogs in OrderActions, TransportRequestCard, WarehouseOperatorDashboard, WarehousePage, AdminPricingPanel, MediaManager, SellerListingsTab, BuyerDashboard (offer ones finished in Phase 2).
Schema: 1 new table (+attachments link), new unique index, notification JSON contract (no column change). Additive only.
Tests: guard-matrix, pending-user restriction, clarification idempotency/ordering, notification destinations, RequestFlowModal.

### Phase 2 — Marketplace, negotiation, payment terms, seller invoice (R4, R7)
- `OfferRound` model (proposer, price, qty, payment terms, message, status, supersededBy); one `isCurrent` per offer via partial unique index; accept = transaction with row lock → only one `Order`; expiry/withdraw/decline/superseded handling; `Offer` legacy fields kept and back-filled.
- Structured `PaymentTerms` (type, creditDays 30/60/90/custom 1–365, advance %/amount, balance due event) on `Product`, `OfferRound`, snapshot (immutable JSON + columns) on `Order`; due-date calculator.
- Listing review step, offer review, accept-offer review with fee/net, buyer must explicitly accept terms.
- `SellerInvoice` (unique number, one per order unless voided/replaced, status lifecycle ISSUED→PAYMENT_SUBMITTED→PAYMENT_CONFIRMED / VOID, PDF via existing pdfkit util), buyer + seller views, notifications, audit.

### Phase 3 — Transport lifecycle (R6)
- `TransportQuoteRound` negotiation, `TransportRequest.requestRef` + confirmed `orderRef` (sequence-based, unique), snapshot of agreed terms, `TransportInvoice`, `TransportDelivery acknowledgement` fields + dispute/exception state, buyer-only acknowledgement, driver name/phone through API + tracker with authorization (decision D4).
- Review/confirm flows for request, quote, counter, acceptance, invoice, acknowledgement.

### Phase 4 — Remaining modules + regression
- Lab booking (+product-page lab test wiring bug), loan application review, registration review step, provider-onboarding confirmation, lab report review, dispute resolution review, admin create/suspend/reject confirmations, warehouse confirmations (cancel/insurance/lien/receipt) on the shared components.
- Replace remaining `alert()`; full frontend + backend regression; final report (all 9 deliverables in the brief) and manual acceptance checklist.

## 2. Per-phase delivery package (what you'll get each time)
1. `agri_backend_phaseN.zip`, `agri_frontend_phaseN.zip` — cumulative, no `node_modules`/`dist`.
2. `PHASE_N_NOTES.md` — files changed, schema changes, test + build results (passed/failed/not run), env vars, known limits.
3. Step-by-step: DB backup → apply schema → deploy backend (Railway) → deploy frontend (Vercel) → smoke-test checklist per role → rollback.
4. `HANDOFF.md` — this file updated with “done / next / decisions” so you can continue in a new chat.

## 3. Decisions needed from you (defaults in bold; I will use them if you don't answer)
- **D1 Schema deployment:** the repo has a `0_init` baseline and the entrypoint runs `migrate deploy`, but your earlier phases used `db push`. Default: I ship real SQL migration files (additive only) **and** they work with either method. Confirm which one Railway actually runs today.
- **D2 Pending users:** default = **they can log in and browse/read; everything transactional returns 403**; rejected users get a read-only session limited to account/documents with the rejection reason. Suspended users stay locked out.
- **D3 Payment terms scope:** default = **all five types incl. partial advance**; credit period starts at **delivery acknowledgement date** unless the parties pick “invoice date”.
- **D4 Public tracking link:** default = **`/transport/track/:id` stays public but redacts driver phone; full driver name + phone shown only to the authenticated buyer/transporter/admin.** (This is the open question from earlier rounds.)
- **D5 Platform fee on invoice:** default = **invoice is for the full order amount owed by the buyer; platform fee/net-to-seller shown as a separate seller-side section, not added to buyer’s amount.**
- **D6 Test infra:** Prisma's binary CDN may be unreachable in my sandbox. If so I'll still run typecheck/Jest where possible and clearly list anything “not run”; integration tests then need to run on your side (`docker compose -f docker-compose.test.yml up -d && npm run test:integration`).

## 4. Next step
Reply “approved” (or amend D1–D6). I then start **Phase 1** and deliver its package before touching Phase 2.
