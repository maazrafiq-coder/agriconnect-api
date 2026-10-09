# Round 3 — Milestone 2: Core trade loop & offer integrity

Source: review Sections 3 (offer/order logic) and 4–6 (order buttons, counter-offer, Save, Edit).
Cumulative on top of Milestone 1.

## Deploy steps
- **No schema change in this milestone** (no `prisma db push` needed beyond M1's `Otp.attempts`).
- No new env vars.

## Backend
| Review finding | Fix |
|---|---|
| Counter-offers accepted at the wrong price; no way for the buyer to accept | New `PATCH /offers/:id/accept-counter` (buyer only) creates the order at the **counter price**. The seller can no longer "accept" a countered offer (clear error: waiting for the buyer). |
| No buyer way to decline / withdraw | New `PATCH /offers/:id/withdraw` (buyer): withdraws an open offer or declines a counter → `WITHDRAWN`. |
| Offer set to ACCEPTED outside the order transaction | Acceptance is now one interactive transaction: offer → ACCEPTED (guarded on observed status, so double-tap/two-tab races succeed once) → stock deducted (guarded: listing live + enough quantity) → listing flips to SOLD at zero → competing offers closed → order + history + ledger rows. Any failure rolls everything back. |
| Accepting didn't reduce quantity or close competing offers | Quantity is deducted. Competing PENDING/COUNTERED offers are closed **only if they can no longer be fulfilled** (their quantity exceeds remaining stock; all of them if sold out) with a reason shown to the buyer. Offers that still fit stay open. |
| `reject()` could reject an offer that already had an order | Only PENDING/COUNTERED can be rejected; guarded update loses cleanly to a concurrent accept. |
| Offer expiry never enforced | Enforced lazily: acting on a past-deadline offer marks it EXPIRED and refuses; offer lists sweep stale rows. A counter gives the buyer a fresh 72h. |
| Offers on unavailable listings | `create` now requires the listing to be ACTIVE and the quantity ≤ stock; prices/quantities must be > 0. |
| Cancelled orders left stock deducted | Cancelling (by a party, or an admin resolving a dispute as cancelled) puts the quantity back and re-opens a SOLD listing. |
| Order status races | Status update is guarded on the status that was validated and runs in one transaction with the history row. |
| Disputes | Raising a dispute or cancelling now requires a reason (≥ 5 chars); stored in the order history and shown to the other party/admin. |
| Edit listing silently dropped most fields | `UpdateProductDto` now accepts name, description, quantity, price, min order, city/province, harvest date, packaging, delivery terms and rice quality (upserted). Category/unit stay fixed. SOLD/REMOVED listings can't be edited; min order can't exceed quantity. Editing a REJECTED listing still resubmits it for review. |

## Frontend
- **Buyer → new "Offers" tab:** every offer with status, expiry, seller's counter price + total, **Accept counter / Decline**, **Withdraw**, and "Message seller". Accepting jumps to Orders.
- **Order status buttons** (new shared `OrderActions` component, both portals), mirroring the server's state machine: seller *Mark In Transit*; buyer *Confirm Delivery* → *Complete Order*; either party *Cancel* or *Raise dispute* with a written reason; disputed orders show "Under dispute". Server stays the authority.
- **Seller:** *Edit* now opens a pre-filled edit form (no more duplicate listing); accepting an offer reloads offers, orders and listings (stock changed); countered offers say "waiting for the buyer".
- **Save product:** heart button on the product page (hidden on your own listing), initial state read from Saved; the existing Saved tab now fills.
- Status chips for Expired / Withdrawn.

## Tests
`offers.service.spec.ts` rewritten (transaction, counter price, stock, competitors, expiry, races), `orders-status-lifecycle.spec.ts` extended (reasons, stock restore, concurrency, dispute resolve), new `products-update.spec.ts`. Full suite: **309 passing**; `nest build` and `vite build` clean.

## Known limits (scheduled later)
- Ledger rows are still written at acceptance (now atomically). Moving them to the real payment/delivery events, reversing on cancel, and the 1.5% fee setting → **Milestone 3**.
- Buyer is not notified when the seller counters/accepts (and vice-versa) → **Milestone 4** (in-app notifications).
- "/bag" price labels, "ETA: undefined", buyer Transport tab → **Milestone 5**.
- Editing an ACTIVE listing's price/quantity is not re-reviewed by admin (unchanged behaviour).
