# Round 2, Milestone 7 — Remaining audits + hardening

## Migration required: NONE

This milestone was pure backend logic hardening + frontend fixes. No
Prisma schema changes, no new models, no new fields. Nothing to run
against the real database beyond whatever is already pending from
earlier milestones.

## What this milestone covered

Three parts, per the original Round 2 audit plan: an IDOR pass across
every controller/service, a mock-data re-audit on the frontend, and
making the admin dashboard's KPI cards clickable.

### 1. IDOR / authorization audit

Walked every controller and its backing service
(`warehouse`, `review`, `media`, `products`, `offers`/`orders`,
`testing`, `users`) checking that any endpoint taking a resource ID
actually verifies the caller owns or is a party to that resource.

**Clean, no changes needed:** warehouse bookings/receipts/liens/
insurance, review/clarification threads, media, products — all verified
line-by-line, all correctly scoped.

**Two real findings, both fixed:**

- **`PATCH /orders/:id/status`** — previously accepted *any* `OrderStatus`
  from either the buyer or seller, with no transition rules. A party
  could jump an order straight to `COMPLETED`, or move it out of
  `DISPUTED` before an admin ever resolved it — quietly bypassing
  `OrdersService.adminResolveDispute`. Fixed with an explicit
  role-aware transition allow-list (`ORDER_TRANSITIONS` in
  `offers.service.ts`), mirroring the pattern `WarehouseService` already
  uses for booking status. `DISPUTED` is now terminal from this
  endpoint — only the admin resolve-dispute path can move an order out
  of it. `COMPLETED`/`CANCELLED` now also stamp `completedAt` /
  `cancelledAt`+`cancelReason`, which the schema already had fields for
  but nothing was setting.
  New tests: `offers/orders-status-lifecycle.spec.ts` (11 tests).

- **`PATCH /testing/requests/:id/status`** — same shape of bug, more
  serious impact: either the requester *or* the agency could set status
  to `COMPLETED` directly, completely bypassing `submitReport` (the
  endpoint meant to be the *only* legitimate way to complete a request —
  agency-only, requires an actual report). A buyer could previously mark
  their own quality test "completed" with no test ever performed. Fixed
  with the same allow-list pattern (`TESTING_TRANSITIONS` in
  `testing.service.ts`); `COMPLETED` is now explicitly rejected from this
  endpoint with a message pointing at `submitReport` instead, regardless
  of caller or current status. Also hardened `submitReport` itself to
  refuse a cancelled request or a second report on an already-completed
  one.
  New tests: `testing/testing-status-lifecycle.spec.ts` (10 tests).

**Reviewed, accepted as-is:** `GET /transport/track/:id` is public with
no auth check and returns the driver's name/phone by request ID. IDs
are UUIDv4 (not enumerable), and the schema has an unused `trackingUrl`
field suggesting this was intentionally designed as a shareable
tracking link (the same pattern real courier tracking pages use). Not
changed, but worth a decision from the user on whether exposing a
driver's phone number specifically is acceptable for that use case, or
whether it should be redacted on this public route.

### 2. Mock-data re-audit (frontend)

Found one real leak that Round 1's mock-data cleanup missed: the "Book
Testing" modal's "Product to Test" dropdown (`TestingPage` in
`ServicePages.jsx`) always rendered from `MOCK_P` (mock product data),
**unconditionally** — not gated behind `VITE_DEMO_MODE` like every other
mock fallback in the app. Worse, the selected (fake) product name was
embedded directly into the real booking's `notes` field and sent to a
real testing agency. Fixed: now fetches the user's actual listed
products via the existing `GET /products/my` endpoint, with a proper
empty state ("You don't have any listed products yet…") when they have
none.

Also cleaned up while auditing:
- `SellerDashboard.jsx` had a dead, unused `import { PRODUCTS } from
  '../data'` — removed.
- `WarehousePage.jsx` had its own bespoke `DEMO_MODE` constant
  (`String(import.meta.env.VITE_DEMO_MODE)...`) instead of using the
  shared `isDemoMode()` helper from `components/ui` — normalized to
  match every other page.

Every other mock-data fallback found (`HomePage`, `MarketplacePage`,
`ProductDetailPage`, `BuyerDashboard`, `SellerDashboard`'s offers/orders
mocks) was already correctly gated behind `isDemoMode()`/`VITE_DEMO_MODE`
— no changes needed there.

### 3. Clickable KPIs (admin dashboard)

The 6 stat cards on the admin dashboard overview (`AdminDashboard.jsx`)
were static — no click handler at all. Now each navigates to a
filtered view of the relevant data:

- **Total Users** → Users tab, KYC filter cleared
- **Pending KYC** → Users tab, filtered to `SUBMITTED`
- **Active Listings** → Marketplace → Products tab
- **Total Orders** → Marketplace → Orders tab, filter cleared
- **Disputed Orders** → Marketplace → Orders tab, filtered to `DISPUTED`
- **Platform Revenue** → Payments tab

This required adding real filter UI that didn't exist before: a KYC-status
dropdown next to the Users search box, and an order-status dropdown
above the Orders table. The existing "Review" quick-action button in
the Pending Approvals panel was also wired to set the KYC filter to
`SUBMITTED` for consistency.

## Testing

**151/151 backend tests passing** (130 baseline from Milestones 1–6 +
21 new from this milestone's two state-machine fixes). All touched
frontend files pass the `esbuild` syntax check per project convention.

## Files touched

**Backend:**
- `src/offers/offers.service.ts` — order status state machine
- `src/offers/orders-status-lifecycle.spec.ts` — new
- `src/testing/testing.service.ts` — testing status state machine +
  `submitReport` guards
- `src/testing/testing-status-lifecycle.spec.ts` — new

**Frontend:**
- `src/pages/ServicePages.jsx` — real product list in testing booking
- `src/pages/SellerDashboard.jsx` — dead import removed
- `src/pages/WarehousePage.jsx` — `DEMO_MODE` normalized to `isDemoMode()`
- `src/pages/AdminDashboard.jsx` — clickable KPIs + filter UI

## Not started — Milestone 8

Build/E2E verification + final report. This is the last milestone in
the Round 2 plan.
