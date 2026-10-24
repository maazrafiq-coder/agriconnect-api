# Phase 4 - backend notes (brief sections 1-18, final phase)

Status honesty: everything below was verified only by unit tests with an in-memory Prisma double, `tsc`, and the SQL migration chain on a local PostgreSQL 16. NOT run: `test/*.int-spec.ts`, real Prisma client/engine, any browser or live-backend flow. Nothing was deployed.

## 1. Audit summary
- Phase 3 transport lacked brief section 10 items: richer request fields, itemised quote (charges, dates, vehicle, payment terms, conditions, validity), explicit terms acceptance, a transport ORDER number separate from the request ref, delivery evidence, terms-based invoice due date. All closed here.
- Lab requests had no human reference and no idempotency -> TST- reference + Idempotency-Key added.
- Frontend: lab booking, warehouse modals, registration/provider/admin confirmations, native dialogs removed (see PHASE_4_NOTES.md in the frontend zip).

## 2. Changed files (backend)
- `prisma/schema.prisma`, new migration `20261020100000_p4_transport_brief_testing_ref`
- `src/transport/transport.shared.ts`, `transport-lifecycle.service.ts`, `transport-invoice.service.ts`
- `src/testing/testing.service.ts`, `testing.controller.ts`
- `src/common/utils/document-number.util.ts` (prefixes TRO, TST)
- Tests: `transport-lifecycle.spec.ts`, `transport-invoice-dispute.spec.ts` (updated), `src/testing/testing-request-ref.spec.ts` (new), `src/offers/__testing__/fake-prisma.ts`

## 3. New fields / sequences / indexes / migration
- `transport_requests`: deliveryDeadline, commodity, cargoType, specialHandling, contactName, contactPhone, orderSeq (unique), orderNumber (unique, `TRO-YYYY-NNNNNN`), orderConfirmedAt, paymentTermsSnapshot, agreedCharges, agreedConditions, agreedPickupAt, termsAcceptedAt/ById, deliveryReceiverName, deliveryNote, deliveredQuantityTons. Trigger: `paymentTermsSnapshot` and `orderNumber` immutable once set. Sequence `transport_order_seq` (the service also runs `CREATE SEQUENCE IF NOT EXISTS`, so `db push` databases work).
- `transport_quote_rounds`: additionalCharges, totalPrice (NOT NULL, back-filled = price), estimatedPickup, vehicleDetails, paymentTerms, conditions.
- `transport_invoices`: orderNumber, paymentTermsSnapshot, dueDate now nullable.
- `testing_requests`: requestSeq (serial, unique), requestNumber (`TST-YYYY-NNNNNN`, unique, back-filled), clientRequestId + unique(requesterId, clientRequestId).
- Migration is additive and re-runnable. Verified on PostgreSQL 16: full chain, p4 applied twice, legacy rows (booked shipments get TRO numbers oldest-first, invoices inherit them, lab requests get TST numbers), trigger blocks changing orderNumber.

## 4. Workflow matrix (transport)
| Step | Actor | Rule |
|---|---|---|
| Create request (TRQ-) | requester | optional providerId; contact defaults to profile; deadline >= pickup; Idempotency-Key |
| Quote | provider | base + charges (server total), terms REQUIRED, validHours 1-168, arrival >= pickup |
| Counter | either | carries unspecified fields forward; stale roundId = 409 |
| Accept | the other party | needs roundId + acceptTerms=true; one transaction: BOOKED, agreedPrice = round total, TRO- number, terms snapshot |
| Driver/pickup/transit | provider | PICKED_UP needs driver name+phone |
| Delivered | provider | receiver name required; note/quantity stored |
| Acknowledge | requester | DELIVERED -> COMPLETED |
| Invoice | provider | amount = agreedPrice; due date from terms (null = open-ended, e.g. credit from an un-acknowledged delivery) |
| Dispute | either | freezes as DISPUTED; admin resolves |
Public tracking: masked driver, no phone/plate/price, no contact details; shows TRO and TRQ.

## 5. Tests and builds
- Backend: `tsc` clean; jest 609 passed, 18 failed (all `route-ordering.e2e-spec`, needs real Prisma engine - same as Phases 1-3), 1 skipped. New/updated: 32 lifecycle, 9 invoice/dispute, 5 lab-ref/transport-fields, plus earlier suites.
- Frontend: vitest 163/163, `npm run build` OK.
- NOT run: int-specs, browser tests, load tests.

## 6. Safe DB / deploy steps
See DEPLOY_PHASE_4.md. Back up first; no destructive statements; nothing applied by me.

## 7. Environment variables
No new variables. Existing: DATABASE_URL, DB_SETUP_MODE (auto/push/migrate/skip), storage/JWT/SMS vars unchanged.

## 8. Unresolved / assumptions needing approval
1. Idempotency for warehouse lien / insurance / receipt / warehouse-register is sent by the frontend but NOT honoured server-side yet (double submit protection there is UI-only).
2. No scheduled jobs: quotes expire lazily on access; no auto-acknowledgement or auto-expiry of DELIVERED shipments.
3. Admin dispute UI is basic; admin logistics screens do not show TRO.
4. Contact phone is visible to the requester, the assigned provider and admins only (provider sees it once the request is addressed to them); confirm this is the intended exposure.
5. Legacy shipments booked before this phase got back-filled TRO numbers and a missing terms snapshot (invoice falls back to COD-style due on delivery only if a snapshot exists; with none it is open-ended) - confirm.
6. Phase 3 assumptions (7 items in PHASE_3_NOTES.md) still stand.
7. The brief's 18 sections were implemented across Phases 1-4 by my reading; any section you consider incomplete should be flagged.
8. Quotes in PKR only; 7-day dispute window after acknowledgement kept from Phase 3.

## 9. Manual acceptance checklist
Buyer: create a transport request (with commodity, deadline, contact) -> review -> TRQ- shown; receive quote; counter; accept (must tick the terms box) -> TRO- shown; acknowledge delivery (see receiver/evidence); submit invoice payment; raise dispute. Book a lab test from /testing and a product page -> TST- ref, double-click creates one.
Seller: marketplace offers/invoices (Phase 2) still work; transport requests tied to own orders.
Transporter: quote with charges + terms + validity; revise on counter; add driver; mark delivered (receiver required); issue invoice (TRO + terms on PDF; due date per terms); respond to dispute.
Warehouse operator: register -> review -> awaiting verification; accept/decline booking; issue receipt; confirm payment; gate-out.
Laboratory: register -> review; report submit review.
Admin: create/suspend/reactivate user, approve/restore listings, KYC approve, resolve dispute - all with confirmations; no native browser dialogs anywhere.
