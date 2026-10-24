# AgriConnect — HANDOFF (after Phase 3)

Paste this + latest zips (`agri_backend_phaseN.zip`, `agri_frontend_phaseN.zip`) + original brief `attachment.txt` into a new chat and say "Continue with Phase 4".

Stack: NestJS 10 / Prisma 5 / Postgres (Railway, Docker, entrypoint `scripts/docker-entrypoint.sh`, `DB_SETUP_MODE`); React 18 / Vite 5 / vitest (Vercel). Constraints: don't replace the app, don't weaken security, no destructive DB commands, no prod deploy without approval, no secrets/OTPs in output, report passed/failed/not-run honestly.
Decisions (approved defaults): D1 additive SQL migrations that also work with db push · D2 pending users browse, all transactions 403, rejected read-only, suspended locked out · D3 all five payment-term types, credit period from delivery acknowledgement unless parties choose invoice date · D4 `/transport/track/:id` public but driver phone redacted; full driver name+phone only to authenticated buyer/transporter/admin · D5 invoice = full order amount owed by buyer; platform fee/seller net as separate seller-side section · D6 report what couldn't be run.

## DONE — Phase 1 (see PHASE_1_NOTES.md)
Limited sessions + `@RequireApproved()` on all mutating offer/order routes, permissions-matrix test + `docs/PERMISSIONS_MATRIX.md`; clarification thread (`ReviewClarificationMessage`, idempotent `Idempotency-Key`); structured notification destinations + frontend deep links (`lib/deeplink.js`, `useDeepLink`); `RequestFlowModal`, `ConfirmDialog`, `TextPromptModal`, `ApprovalGate`, status banner; all native confirm/prompt removed.
Test status: backend unit all green except `route-ordering.e2e-spec` (needs real Prisma engine; not run in sandbox); frontend 92/92; builds OK.

## Conventions to reuse
- Idempotency: client sends `Idempotency-Key` → `clientRequestId` unique index; P2002 → treat as replay.
- Notifications: always `destination(route, {tab, entityType, entityId})` from `src/notifications/destinations.ts`; add new tabs to `ROUTE_TABS` (a spec scans services for invalid names).
- Frontend flows: `RequestFlowModal` (form→review→success with real server reference) for creates; `ConfirmDialog` for confirm/reason; errors via `describeError`; `newRequestId()` per send intent.
- New mutating routes need `@RequireApproved()` or RolesGuard (permissions-matrix spec fails otherwise).
- Sandbox: Prisma engine download 403 → `npm install --ignore-scripts && node scripts/build-prisma-shim.js`; unit tests stub Prisma. A local Postgres 16 is available in the sandbox for SQL checks (run as non-root user, data dir under /var/tmp).

## DONE — Phase 2 (see PHASE_2_NOTES.md, DEPLOY_PHASE_2.md)
`OfferRound` negotiation (one CURRENT round per offer: partial unique index + `lockOffer` FOR UPDATE; accept = one transaction → one Order); `PaymentTerms` JSON (`src/offers/terms/payment-terms.ts`: normalise/validate/schedule) on Product + rounds, frozen as `Order.paymentTermsSnapshot` (DB trigger + no service writes); buyer must tick `acceptTerms` on create and every accept; `SellerInvoice` (`SINV-YYYY-nnnnnn`, one live per order, ISSUED→PAYMENT_SUBMITTED→PAYMENT_CONFIRMED/VOID, replace = void+reissue, PDF via pdfkit, buyer redaction of fee/net, `sellerSettlement` for seller). Frontend: MakeOfferFlow, ProposeRoundFlow, AcceptRoundDialog, NegotiationTimeline, PaymentTermsEditor/View, OrderTermsAndInvoices, NewListingModal review step.
Test status: backend jest 557 pass / 18 fail (all `route-ordering.e2e-spec`, needs Prisma engine, not run); frontend 113/113; builds OK; migration verified on Postgres 16. NOT run: `test/*.int-spec.ts`, real Prisma client, browser/manual UI.

## Conventions added in Phase 2
- Offer state lives in `offer_rounds`; legacy `Offer.counter*` columns are mirrored, never the source of truth. Always go through `OffersService.propose/acceptRound` and take `lockOffer` before changing rounds.
- Never update `Order.paymentTermsSnapshot` after it is set. Use `contextFromOrder` + `computeSchedule` for due dates.
- Seller-only money (platformFee, platformFeePct, sellerNet) must be redacted for buyer responses and PDFs (see `SellerInvoiceService.shape`).
- Seller-invoice frontend APIs are prefixed `apiSale…` (warehouse invoices own `apiGetInvoice` etc.).
- Tests: `src/offers/__testing__/fake-prisma.ts` is a stateful in-memory Prisma double (transaction mutex + rollback); excluded from the build.
- Frontend: `useRequestId` gives one Idempotency-Key per payload signature; `lib/offerRounds.js` (`currentRound`, `turnOf`).
- Notification tab `orders` now also serves `type=invoice` (`lib/deeplink.js`).

## DONE — Phase 3 (see PHASE_3_NOTES.md in both zips, DEPLOY_PHASE_3.md)
Transport lifecycle: `TRQ-/TINV-/TDS-` refs; `TransportQuoteRound` (quote/counter/accept/reject, one CURRENT per request via partial unique index + `lockRequest`, 72h lazy expiry, Idempotency-Key, stale roundId=409); accept = one transaction -> BOOKED at round price (`agreedPrice` immutable + DB trigger); driver name/phone/plate (PICKED_UP requires name+phone); D4 public tracking masks driver, hides phone/plate/price; requester acknowledgement (DELIVERED->COMPLETED); `TransportInvoice` (provider->requester, agreed price, due +7d, PDF, submit/confirm/reject/void/replace, no platform fee); `TransportDispute` (either party, freezes shipment as DISPUTED, respond/withdraw/admin resolve). Code in `src/transport/` (backend), `components/transport/` + rebuilt `TransportRequestCard` (frontend).
Test status: backend jest 596 pass / 18 fail (all `route-ordering.e2e-spec`, needs Prisma engine) ; frontend 140/140; both builds OK; migration verified on Postgres 16 (twice, with legacy rows). NOT run: `test/*.int-spec.ts`, real Prisma client, browser/manual UI. Original brief `attachment.txt` was missing in this phase - assumptions listed in backend PHASE_3_NOTES.md (7 items) need confirming.

## Conventions added in Phase 3
- Controller files MUST end in `.controller.ts` (route audits scan that suffix) and be added to the permissions-matrix CONTROLLERS list.
- Transport state lives in `transport_quote_rounds`; `TransportRequest.quotedPrice/quoteNote` only mirror the CURRENT round. Never write `agreedPrice` after BOOKED.
- Transport status adds COMPLETED (acknowledged) and DISPUTED (+ `statusBeforeDispute`). Public views map them to coarse statuses.
- Fake DB: `offers/__testing__/fake-prisma.ts` now also models transport tables + partial unique indexes.
- Transport notification deep links all use `entityType: 'transport'` (buyer: /buyer?tab=transport, provider: /transport-portal).
- Prisma sandbox: `npm install --ignore-scripts && node scripts/build-prisma-shim.js`; if bcrypt specs fail run `npm rebuild bcrypt`.

## DONE - Phase 4 (see PHASE_4_NOTES.md, DEPLOY_PHASE_4.md)
Transport brief s.10: request fields (commodity, cargo type, deadline, handling, contact), quote with itemised charges/dates/vehicle/payment terms/conditions/validity (server-side total), explicit `acceptTerms` on accept, confirmed order number `TRO-YYYY-NNNNNN` (own sequence `transport_order_seq`, distinct from TRQ-), immutable terms snapshot (+trigger), delivery evidence (receiver required), invoice due date from terms (nullable = open-ended), TRO on invoice/PDF. Lab requests: `TST-` reference + Idempotency-Key. Frontend: lab booking flow, warehouse/registration/provider/admin review+confirm flows, native alert/confirm/prompt removed (`lib/notify.js`, `NoticeHost`), full transport UI (CreateTransportRequestFlow, QuoteRoundFlow, AcceptTransportDialog, delivery evidence).
Test status: backend jest 609 pass / 18 fail (all `route-ordering.e2e-spec`, needs Prisma engine); frontend 163/163; builds OK; p4 migration verified on Postgres 16 (twice, legacy rows, trigger). NOT run: `test/*.int-spec.ts`, real Prisma client, browser/manual UI.

## Conventions added in Phase 4
- Transport money: `computeTotal(base, charges)` is the only total; `quotedPrice`/`agreedPrice` = total. Never trust a client total.
- Terms on transport reuse `src/offers/terms/payment-terms.ts`; invoice due date = `finalDueDate(computeSchedule(snapshot, ...))`, may be null.
- Two references per shipment: `requestNumber` (TRQ-) and `orderNumber` (TRO-, set on accept). `orderRef` is the marketplace order.
- Lab requests: `requestNumber` TST-, honour Idempotency-Key.
- Fake DB now also has testingRequest/testingAgencyProfile/profile and answers `nextval('transport_order_seq')`.

## OPEN / next
Server-side idempotency for lien/insurance/receipt/warehouse-register; scheduled jobs (auto-expiry, auto-acknowledge); admin screens showing TRO; richer admin dispute UI; run int-specs and a browser pass in a real environment; confirm the assumptions in PHASE_3_NOTES.md and PHASE_4_NOTES.md section 8.
