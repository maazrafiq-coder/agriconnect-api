# Warehouse module fixes (Oct 2026)

**Schema changed** — run `npx prisma db push` before starting the backend.
Adds `BookingMessage` + `BookingMessageKind`. (db push is also what removes
the old UNIQUE index on `warehouse_profiles.userId` if your DB predates the
multi-warehouse change — without it a 2nd listing fails at the database.)

| # | Issue | Cause / change |
|---|-------|----------------|
| 1 | Can't edit listings | Operator dashboard crashed on render: `clarifications`/`setClarifications` were never declared (ReferenceError), so the page (and its Edit button) never appeared. State added. |
| 2 | Can't add 2+ listings | Same crash hid the warehouse picker and "+ Add Another Warehouse"; picker now always renders. Needs `db push` (above). |
| 3 | Profile shows 0 listings | Profile counted only products. `getProfile` now returns `_count.warehouseProfiles`; AccountPage shows "Warehouse Listings". |
| 4 | Search empty until Clear | `useMemo` deps fix is already in this build — make sure the deployed frontend is this one. |
| 5 | Insurance error on booking | A warehouse had "insurance available" ticked with no rate. Backend now refuses create/update that offers insurance without a rate; both forms validate too. **Existing listings** in that state must be edited once to set a rate. |
| 6 | Booking details + request info | New Booking Detail modal: full booking, requester contact/KYC, depositor notes, conversation thread. Operator can tick "Request more information" (highlighted amber for the depositor). |
| 7 | GRN / gate-out pass not visible | Paperwork row now always shown on live bookings (both sides) with status placeholders; GRN appears once the receipt is issued, gate pass after release approval. |
| 8 | Messaging | `GET/POST /warehouse/bookings/:id/messages`. Depositor + operator post; admin/moderator read-only; closed after reject/cancel. 15s polling. |
| 9 | No insurance rate on listing | The field existed behind the "insurance available" checkbox; it is now required when ticked. |

Also: operator dashboard `totalBookings` was capped at 10 — now a real count; list shows latest 50.
Tests: 161 passing (7 new in warehouse-messaging.spec.ts).
