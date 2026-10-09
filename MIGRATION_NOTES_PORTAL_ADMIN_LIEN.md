# Round B — admin detail view, portal reset, lien flow, documents

## Deploy steps
1. `npx prisma db push` (new `BookingMessage` model + `BookingMessageKind` enum from the earlier round; Notification table already existed).
2. Redeploy backend (Railway) and frontend (Vercel).

## What changed
- **Admin listing detail**: `GET /admin-review/:type/:id` (warehouse | testing_agency | transport | product; ADMIN/MODERATOR). Names in Admin → Logistics and Marketplace → Products are clickable; Dashboard "Pending Approvals" now includes unverified warehouses/agencies/transporters and pending product listings. Shows all listing fields, owner contact, owner's KYC documents (signed links), listing photos/documents/certificates, stats, clarification thread.
- **Seller/Buyer portals**: hard-coded demo content removed (header, stats, offers badge, messages, warehouse, buyer transport/saved counts). Header comes from the real profile + KYC status. Seller Messages are derived from real offers (no chat backend exists for seller<->buyer). Demo-mode mock fallbacks removed from both portals.
- **Portal Warehouse tab** (both portals): live bookings + receipts with lien/insurance status.
- **Documents upload**: Profile → Documents has an upload form (type + file, 10 MB, PDF/image). Re-upload after a REJECTED KYC moves status back to SUBMITTED.
- **Bank loan / lien**: warehouse operator, depositor (and admin via API) are notified when a lien is placed or cleared; an ACTIVE lien blocks gate-out requests and approvals; bookings/receipts show "Under bank lien". Clearance is recorded with a bank reference by the warehouse operator or admin/moderator (not the depositor). Admin has no UI button for clearance yet.
- **Notifications**: bell in navbar, `/notifications` API.

## Note on old data
The demo content was hard-coded in the UI, not stored in the database, so no DB reset is needed. Any real test rows in your DB (bookings, offers) still show for the accounts that own them.

## Follow-up (admin lien clearance + review fixes)
- Admin → Logistics → click warehouse name → "Active Bank Liens" with a **Record bank clearance** button (asks for the bank's reference).
- Admin lists (users/products/orders) now request up to 200 rows; server caps `limit` at 200. Before, only the first 20 were ever shown.

## Hardening pass
- `GET /transport/track/:id` (public) no longer returns `driverPhone`.
- `bookStorage`: capacity check + insert now run in one transaction with the warehouse row locked (`FOR UPDATE`), so concurrent requests can't oversell capacity. New spec: `warehouse-booking-capacity.spec.ts`.
- Frontend: demo/mock fallbacks and `isDemoMode` removed everywhere; the login box no longer silently signs in with demo credentials when fields are empty; dead buttons wired (order timeline "Details", testing "View Report", receipt "Print / Save as PDF") or removed (Track, Rate, Share with Bank); admin reject/request-info/lien-clearance and the operator clearance use a proper dialog instead of `prompt()`.

## Remaining items pass
**Run `npx prisma db push` again** — new `OfferMessage` model and new indexes (User kycStatus/createdAt, Product status+createdAt, Order createdAt, StorageBooking warehouseId+status, Notification userId+isRead+createdAt).
- **Offer chat**: `GET/POST /offers/:id/messages` (buyer and the product's seller only; read-only once the offer is expired/withdrawn; notifies the other side). Seller Messages tab is now a real chat per offer; Buyer portal has a new Messages tab.
- **Admin paging/search**: Users and Products tables are paged (20/page) by the API, user search is server-side (debounced; matches AGC ID, phone, email, name, business), products have a status filter. Dashboard counts come from API totals. Orders still load the latest 200.
- **Mobile**: fixed two/three-column grids now collapse on narrow screens; admin sidebar wraps above content.
