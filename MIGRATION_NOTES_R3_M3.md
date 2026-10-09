# Round 3 — Milestone 3: Financial integrity

Cumulative on top of Milestones 1–2. (Per your instruction: payments relabelling and SMS are untouched.)

## Deploy steps
1. `npx prisma db push` — **required** (additive only):
   - `LienStatus` enum: PENDING, ACTIVE, RELEASED, DEFAULTED, REJECTED, WITHDRAWN
   - `BankLien`: `status` default now PENDING; new `decidedById`, `decidedAt`, `decisionNote`
   - `WarehouseReceipt.receiptSeq`, `StorageInsurance.policySeq` (autoincrement; existing rows get numbers)
   - New tables `PlatformSetting`, `CommodityPrice`
2. **Set commodity prices** in Admin → Settings → "Fee & Commodity Prices". Until a price exists for a commodity, new receipts are "valuation pending" and cannot be used for loans (previously every commodity was silently valued at ₨38,000/ton). Setting the price values receipts that were waiting.
3. Platform fee defaults to 1.5% until an admin changes it (applies to new orders only).
4. Existing ACTIVE liens stay ACTIVE. Existing ledger rows are unchanged.

## Backend
| Finding | Fix |
|---|---|
| Ledger booked income at offer acceptance | Acceptance books nothing. ORDER_PAYMENT (net) + PLATFORM_FEE are written, idempotently, when the order is COMPLETED (buyer, or admin resolving a dispute as completed). |
| Admin revenue summed 200 loaded orders incl. cancelled/disputed | `GET /orders/admin/summary`: revenue = fees on COMPLETED only; in-progress shown separately. |
| Hard-coded 1.5% fee | Admin-editable (`/settings/admin/platform-fee`, 0–25%), snapshotted on each order. |
| Hard-coded ₨38,000/t valuation | Admin commodity price table; 0 = "valuation pending". |
| Storage fee booked at booking time | Booked (with insurance premium) when the invoice is confirmed paid; guarded so double-click can't book twice. Cancelling/rejecting a booking whose invoice was paid writes a REFUND row. |
| Loan applied = lien + disbursement instantly | Application is PENDING (receipt held, gate-out blocked). Admin/moderator **confirms** (bank loan ref required → ACTIVE + LOAN_DISBURSEMENT) or **declines** (reason required, goods released). Depositor can withdraw while pending. Clearance writes LOAN_REPAYMENT. |
| Non-atomic receipt/GRN/lien/insurance creation; racy numbering | Single transactions; document numbers from DB sequences (`WR-…`, policy numbers). |

New routes: `GET/PUT/DELETE /settings/admin…` (ADMIN), `GET /orders/admin/summary`, `PATCH /warehouse/lien/:id/withdraw`, `GET /warehouse/admin/liens`, `PATCH /warehouse/admin/liens/:id/confirm|reject` (ADMIN/MODERATOR).

## Frontend
- Admin: Settings → Fee & Commodity Prices; new "Loan Applications" queue (confirm / decline); Payments cards now use server totals (completed vs in-progress).
- Depositor: pending/declined/withdrawn lien states, Withdraw button, "Valuation pending", indicative-rate wording.
- Operator/portal: a PENDING application blocks gate-out and shows a warning.

## Tests
339 passing (new: settings, lien confirm/reject/withdraw, settlement + idempotency, refunds, admin summary).
