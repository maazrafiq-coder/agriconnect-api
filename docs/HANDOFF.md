# AgriConnect — HANDOFF (after Phase 2)

Paste this + latest zips (`agri_backend_phaseN.zip`, `agri_frontend_phaseN.zip`) + original brief `attachment.txt` into a new chat and say "Continue with Phase 3".

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

## NEXT — Phase 3: transport lifecycle (R-transport)
Quote rounds, request/order refs, transport invoice, driver details per D4, buyer acknowledgement, dispute. Reuse OfferRound-style locking, idempotency, destinations and the invoice patterns above.

## LATER
Phase 4: lab booking (+ product-page lab test wiring bug), loan application review, registration review step, provider onboarding, lab report review, dispute resolution review, admin create/suspend/reject confirmations, warehouse modals onto RequestFlowModal (BookingModal etc.), replace remaining 26 `alert()`s, full regression, final report (9 deliverables) + acceptance checklist.
