# Round 3 · Milestone 5 — Transport/lab flows, credibility & UI polish

## Database (run `prisma db push`)
- `TestingRequest`: new `reportFileKey`, `reportFileName` (permanent lab-report file; nullable).
- `TransportRequest`: new `quoteNote`, `quotedAt` (nullable).
No data backfill needed.

## Behaviour changes
- **Transport price now comes only from the provider's quote.** "Book" sends the request to a provider (status REQUESTED); provider quotes (QUOTED); requester accepts (BOOKED, agreedPrice = quote). Provider can decline; requester can cancel before pickup. Tracking is a guarded state machine (BOOKED → PICKED_UP → IN_TRANSIT → DELIVERED).
- **Lab reports are stored permanently** (`POST /testing/requests/:id/report-file`, PDF/JPG/PNG, 10 MB). Download via `GET …/report-file` mints a fresh 10-minute link. Completing a request requires a file, a link or result notes.
- **Mark Complete on a storage booking requires an APPROVED gate-out pass.**
- **Insurance is priced server-side**: premium = warehouse insurance rate × tons × months left; cover = receipt value. Warehouse operators must set an insurance rate (Listing → Insurance) or cover can't be bought. Client-sent premium/provider/cover are ignored. Preview: `GET /warehouse/insurance/quote/:receiptId`.

## New endpoints
- `GET /public/stats` (public, cached 5 min, throttled)
- `GET /audit/admin?action&userId&page&limit` (ADMIN)
- `PATCH /transport/requests/:id/{quote,accept,decline,cancel}`

## Audit trail
KYC decisions, user activate/deactivate, listing approve/reject/remove/restore, warehouse/lab/transport verify & activate, lien confirm/reject, fee & commodity price changes, dispute resolutions.

## Frontend
Real home stats (hidden when unavailable), category chips pass `?category=`, marketplace Load more (Top Rated removed — not implemented), "Not provided" instead of ✓ Good/null, unit-aware price labels, receipt numbers, honest warehouse/insurance copy, working Contact Manager (tel link), Help/Disputes/Contact/Terms pages, public `/track/:id`, buyer Transport tab with quote accept/decline, provider quote/decline/tracking (with ETA), edit lab & fleet listings, operator Invoices and Gate-Out tabs, admin Audit Log (replaces Coming Soon sections). Optional env: `VITE_SUPPORT_EMAIL` for the Contact page.

Payments wording ("Confirm & Pay") and SMS were intentionally left unchanged.
