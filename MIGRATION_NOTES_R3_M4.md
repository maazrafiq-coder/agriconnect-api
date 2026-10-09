# Round 3 — Milestone 4: Account flows & in-app notifications

Cumulative on top of Milestones 1–3.

## Deploy steps
1. `npx prisma db push` — additive: `RefreshToken.rotatedAt`, `RefreshToken.revokedAt` (nullable). Existing tokens keep working.
2. No new env vars.

## Backend
| Finding | Fix |
|---|---|
| No way to resend a registration OTP (the UI re-submitted the whole form and hit "already registered") | `POST /auth/resend-otp {identifier}` — only for unverified PENDING accounts; same generic reply for unknown/verified/suspended (no user enumeration); shares the 5-codes-per-15-min cap. |
| Abandoned sign-ups locked the phone/email forever | Registering with a phone/email that belongs to an **unverified PENDING** account now takes that registration over (new password/role/name, fresh OTP). Verified or reviewed accounts still return 409. A phone and an email belonging to two different pending registrations → 409. |
| Refresh tokens could be replayed after rotation | Rotation is guarded (`rotatedAt`). Presenting an already-rotated token (>10 s after rotation) revokes **every** session for that user and writes a `refresh_token_reuse` audit entry. A 10 s grace window covers two tabs refreshing together; a logged-out token is just refused. |
| Moderators could not open the registration queue | `GET /users/admin/list` and `/admin/:id/detail` now allow MODERATOR (read-only). KYC approve/reject and suspend stay ADMIN-only. |
| Nothing in-app told people what happened | Notifications (best-effort, never fail the action): new offer → seller; counter → buyer; decline/withdraw → the other side; accepted (either way) → the other party; order status changes → the other party; dispute resolved → both; KYC approved/rejected → user; listing approved/rejected → seller; test request status + **test report ready** → requester. (Warehouse/lien notifications already existed.) |

## Frontend
- **Forgot password**: "Forgot password?" on login → phone/email → OTP + new password (sessions are ended).
- **Registration**: Resend now calls the new endpoint with a 30 s cooldown; sellers choose Farmer / Trader / Miller / Exporter (previously everyone became TRADER); the document-upload step survives a page refresh (registration token + step marker kept in `sessionStorage`, per tab, cleared when finished).
- **Login**: removed the non-functional Buyer/Seller/Others selector and the misleading "(optional)" labels.
- **Moderator**: lands on the portal (`/admin`, reduced to Dashboard / Users / Loan Applications) and sees **Recommend for approval** + **Request info** instead of Approve/Reject.
- **Admin listing modal**: Approve (and, for products, Reject) directly from the detail view.

## Tests
356 passing (new: refresh reuse detection incl. grace window, resend OTP, abandoned-account takeover, notification triggers, moderator role metadata).
