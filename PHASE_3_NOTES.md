# Phase 3 - Transport lifecycle (backend)

Built from HANDOFF.md + decisions D1-D6. The original brief (`attachment.txt`) was not attached to this session, so
anything not covered by the handoff is an assumption - listed under "Assumptions" below. Please check those first.

## What it does
| Area | Behaviour |
|---|---|
| References | Every request gets `TRQ-YYYY-nnnnnn` (back-filled for existing rows); invoices `TINV-…`; disputes `TDS-…`. Order link shows `orderRef` (first 8 chars of the order id - the same reference the seller invoice uses). |
| Quote rounds | `transport_quote_rounds`. Provider quotes, requester counters, provider counters back. One CURRENT round per request (partial unique index + `FOR UPDATE` lock). Rounds expire after 72 h (swept lazily, no cron). `Idempotency-Key` makes a retried send a replay. Stale `roundId` => 409. |
| Accept | Either party accepts the OTHER party's CURRENT round (`roundId` required). One transaction: round ACCEPTED, request BOOKED, `agreedPrice` = round price. `agreedPrice` is immutable (service never rewrites it + DB trigger). |
| Reject / decline / cancel | `reject-quote` (either party, reason) returns to "awaiting quote"; `decline` unassigns the provider; `cancel` until pickup. All close the CURRENT round. |
| Driver (D4) | name, phone, plate (`vehicleRegNo`) set by the provider while BOOKED/PICKED_UP/IN_TRANSIT. **PICKED_UP now requires driver name + phone.** Public `GET /transport/track/:id`: driver name masked ("Ali K."), no phone, no plate, no price, DISPUTED/COMPLETED shown as the coarse status. Full details only to the authenticated requester, assigned provider and admin. Notifications never contain the phone. |
| Acknowledgement | Requester acknowledges DELIVERED -> `COMPLETED` (`acknowledgedAt/By/Note`). Blocked while DISPUTED. |
| Transport invoice | Provider issues after delivery; amount = agreed price (never client input); due 7 days after issue; PDF via pdfkit; ISSUED -> PAYMENT_SUBMITTED -> PAYMENT_CONFIRMED / VOID; reject-payment, void, replace (version+1); one live invoice per shipment (partial unique index + lock). Requester cannot submit payment while DISPUTED. **No platform fee** exists for transport. |
| Dispute | Either party on DELIVERED, or COMPLETED within 7 days of acknowledgement. Freezes the shipment (`DISPUTED`, previous status saved). Other party responds; raiser can withdraw; admin resolves (`FAVOUR_REQUESTER` / `FAVOUR_PROVIDER` / `SETTLED` + note). Shipment returns to its prior status. One open dispute per shipment. |

## Code map
`src/transport/`: `transport.shared.ts` (states, TTLs, shaping + D4 redaction), `transport-lifecycle.service.ts`,
`transport-invoice.service.ts`, `transport-dispute.service.ts`, `transport.controller.ts` (4 controllers, file name must end
in `.controller.ts` so the route audits scan it). Quote/accept/decline/cancel/tracking/track/list moved out of
`TransportService` (testing.service.ts) into the lifecycle service; `createRequest` (idempotent, TRQ ref, order ownership
check) and `book` (withdraws open rounds) stay there. New controllers are registered AFTER `TransportController` in
`testing.module.ts` - `transport-routes.spec.ts` guards route shadowing.

## API (all new mutating routes are `@RequireApproved()` or admin `RolesGuard`)
`GET transport/requests/my`, `GET transport/requests/:id`, `PATCH .../quote | counter | accept | reject-quote | decline | cancel | tracking`,
`POST .../acknowledge`, `GET transport/track/:id` (public), `POST transport/disputes/request/:requestId`, `GET transport/disputes/my|:id`,
`POST transport/disputes/:id/respond|withdraw`, `GET transport/admin/disputes`, `POST transport/admin/disputes/:id/resolve`,
`/transport-invoices/{my,issued,request/:requestId,:id,:id/submit-payment|confirm-payment|reject-payment|void|replace}`.
**Breaking:** `PATCH requests/:id/accept` now needs `{ roundId }`, `decline` needs `{ reason }` as a body object (unchanged), so deploy backend + frontend together.

## Data / migration (D1)
`prisma/migrations/20261019100000_p3_transport_lifecycle/migration.sql` - additive, re-runnable, also fine after `db push`.
Adds enum values `TransportStatus.COMPLETED/DISPUTED`, 4 enums, columns on `transport_requests`, tables `transport_quote_rounds`,
`transport_invoices`, `transport_disputes`, 3 partial unique indexes, the `agreedPrice` immutability trigger, and back-fills request
refs + a round per quoted/booked request. Requires PostgreSQL 13+.

## Assumptions (not in HANDOFF - confirm or tell me to change)
1. Invoice due date = issue date + 7 days (`INVOICE_DUE_DAYS`). No transport payment-terms object like the seller side.
2. No platform fee on transport invoices.
3. Quote validity 72 h; dispute window after acknowledgement 7 days.
4. Public tracking shows the driver's masked first name + last initial (D4 only said phone is redacted).
5. PICKED_UP requires driver name + phone (new rule).
6. `orderRef` = first 8 chars of order id (orders have no human number yet).
7. `createRequest` with an `orderId` now requires the caller to be that order's buyer or seller.

## Test status (honest)
- `npx jest`: **596 passed, 18 failed, 1 skipped**. All 18 failures are `route-ordering.e2e-spec` (needs the real Prisma engine; unchanged from Phase 1/2). Previous: 557 pass.
- New: `transport-lifecycle.spec` (25), `transport-invoice-dispute.spec` (14), `transport-routes.spec` (2); permissions matrix + public-routes now cover the new controllers (128 matrix tests pass; `docs/PERMISSIONS_MATRIX.md` regenerated). The old mock-based `transport-quote.spec.ts` was replaced by the stateful-fake specs.
- `nest build`: OK. Migration applied twice on a local PostgreSQL 16 on top of 0_init+P1+P2 with legacy rows seeded; back-fill, immutability trigger, and the three partial unique indexes verified by direct SQL.
- **NOT run:** `test/*.int-spec.ts` (rewritten for the new services in `test/transport.int-spec.ts`, needs a real Prisma client + `TEST_DATABASE_URL`), real Prisma client against the new schema (shim only), PDF rendering against real S3, browser/manual UI.

## Known gaps / not done
- No auto-acknowledgement or auto-expiry job (expiry is lazy; an un-acknowledged delivery stays DELIVERED until the buyer acts or disputes).
- Admin dispute UI is a basic list + resolve dialog (full review UX is Phase 4 "dispute resolution review").
- Shipment/invoice/dispute notifications deep-link via `entityType: 'transport'` to the request card (no separate invoice/dispute entity types).
