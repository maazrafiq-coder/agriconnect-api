# AgriConnect — Phase 1 notes (foundations, access control, clarification thread, notification links, dialogs)

## What this phase fixes
| Issue | Root cause | Fix |
|---|---|---|
| Clarification reply: "authorization error" on 2nd click, reply not shown as sent | First reply set `kycStatus=SUBMITTED`; `JwtStrategy` only allowed APPROVED/INFO_REQUESTED sessions, so the next request returned 401. Only one `responseMessage` per clarification (a 2nd reply overwrote the 1st). | Sessions allowed for every non-PENDING, non-suspended state. New `ReviewClarificationMessage` thread (idempotent via `Idempotency-Key`). Reply UI locks while sending, keeps text on failure, shows "✓ Sent". |
| Pending users can't browse | Login returned 403 for PENDING/SUBMITTED/RECOMMENDED/REJECTED; offers/orders controllers were not approval-gated | Those users get a limited session (`limitedAccess:true`); every mutating route requires `@RequireApproved()` (403 otherwise). UI banner + "Approval needed" modal. |
| Declined-offer notification goes nowhere | Notifications held only a coarse `/buyer` link | Structured destination `{route, tab, entityType, entityId, link}`; dashboards read `?tab=&type=&id=`, highlight the record, show a notice if it no longer exists. |
| Native `confirm()/prompt()` | 12+ sites | All replaced with `ConfirmDialog`/`TextPromptModal` (states consequences, collects reason, locks while busy, shows server error). |

## Decisions applied (D1–D6)
D2: PENDING (OTP not yet verified) and suspended accounts still get **no** session. SUBMITTED / RECOMMENDED / INFO_REQUESTED / REJECTED get a limited, read-only session. D1: SQL migration shipped (additive, re-runnable); works with `migrate` or `push`.

## Schema change (additive only — nothing dropped or rewritten)
- New table `review_clarification_messages` (+ unique `(clarificationId, clientRequestId)`, index `(clarificationId, createdAt)`).
- New nullable column `clarification_attachments.messageId` (+ index, FK ON DELETE SET NULL).
- Migration `prisma/migrations/20261017100000_p1_clarification_thread/migration.sql` back-fills existing request/response pairs into messages. Needs Postgres 13+ (`gen_random_uuid()`).
- Even without the back-fill, the API synthesises legacy rows on read, so nothing breaks.

## Files changed (backend)
auth: `jwt.strategy.ts`, `auth.service.ts` (+ `auth-hardening.spec.ts`, `jwt.strategy.spec.ts`); offers: `offers.controller.ts`, `orders.controller.ts`; review: `review.service.ts`, `review.controller.ts`, `review.service.spec.ts`; notifications: new `destinations.ts` + `destinations.spec.ts`, applied in `offers.service.ts`, `offer-messages.service.ts`, `products.service.ts`, `users.service.ts`, `warehouse.service.ts`, `testing.service.ts`; new `common/guards/permissions-matrix.spec.ts` + generated `docs/PERMISSIONS_MATRIX.md`; `prisma/schema.prisma` + migration above.
## Files changed (frontend)
New: `lib/errors.js`, `lib/access.js`, `lib/deeplink.js`, `context/ApprovalGate.jsx`, `components/AccountStatusBanner.jsx`, `components/DeepLinkNotice.jsx`, `components/ui/RequestFlowModal.jsx`, `components/ui/ConfirmDialog.jsx` (+ tests).
Rewritten/edited: `ClarificationThread.jsx`, `NotificationBell.jsx`, `lib/api.js`, `AuthContext.jsx`, `App.jsx`, `AuthModals.jsx`, `ProfileTab.jsx`, `ProductDetailPage`, `ServicePages`, `WarehousePage`, `SellerDashboard`, `SellerListingsTab`, `BuyerDashboard`, `AccountPage`, `AdminDashboard`, `WarehouseOperatorDashboard`, `TransportProviderDashboard`, `TestingAgencyDashboard`, admin detail modals, `OrderActions`, `TransportRequestCard`, `MediaManager`, `AdminPricingPanel`. `BuyerDashboard.offers.test.jsx` updated to drive the new dialog instead of `window.confirm`.

## Verification results (honest)
| Check | Result |
|---|---|
| Backend `tsc --noEmit` | PASS |
| Backend `nest build` | PASS |
| Backend Jest (unit) | 502 passed, 1 skipped, **18 failed — all in `route-ordering.e2e-spec.ts`**. That suite boots the real app against a live Prisma engine/DB; in my sandbox the Prisma engine can't be downloaded (403) so the app doesn't start ("Cannot read properties of undefined (reading 'close')"). Environment limit, not a code regression — **NOT RUN here; run on your side** (see below). |
| Backend integration specs (`test/*.int-spec.ts`) | **NOT RUN** (need Postgres :5433 + Prisma engine). |
| Migration SQL | PASS on a real Postgres 16: applied after `0_init`; legacy clarification rows + attachment back-filled correctly; re-run is a no-op. |
| Frontend vitest | PASS 17 files / 92 tests |
| Frontend `vite build` | PASS |
| Browser / manual UI test | **NOT RUN** — use the checklist in `DEPLOY_PHASE_1.md`. |

## Known limits / deferred to a later phase
- `BookingModal` (and warehouse cancel/insurance/lien modals) are **not yet** moved onto `RequestFlowModal` — deferred to Phase 4 with the other module review flows (kept unchanged to avoid regressions in a working flow). The component is built and tested.
- 26 informational `alert()` calls remain (admin panels etc.) — Phase 4. They are not confirm/prompt dialogs.
- Offer accept/decline/withdraw uses `ConfirmDialog` now; the repeated-counter-offer redesign is Phase 2.
- Operator-registration actions (warehouse/transport/testing) are guarded on the backend; per-button UI gating for them is only partial.

## Env vars
No new variables. Optional existing: `DB_SETUP_MODE` (auto|push|migrate|skip).
