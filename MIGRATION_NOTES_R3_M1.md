# Round 3 — Milestone 1: Access control & auth hardening

Source: "AgriConnect — Application Review", Section 2 (items 1–9) + one extra finding.

## Deploy steps (IMPORTANT)
1. **Schema changed**: `Otp.attempts Int @default(0)` → run `npx prisma db push` (or your migration) before starting the backend.
2. **Everyone is signed out once.** Refresh tokens are now stored as SHA-256 hashes, so the old plain-text rows in `refresh_tokens` no longer match. Users just log in again. (Optional: `DELETE FROM refresh_tokens;`)
3. **Production env**:
   - `OTP_DEV_MODE=true` now **stops the app booting** in production. There is still no SMS provider, so if your Railway deployment relies on `000000` for UAT, add `ALLOW_INSECURE_DEV_OTP=true` (boot succeeds, a warning is logged on every start). Remove both once real OTP delivery exists.
   - `/docs` (Swagger) is **off in production**. To keep it: `ENABLE_SWAGGER=true` + `SWAGGER_USER` + `SWAGGER_PASSWORD` (basic auth).
   - `JWT_REFRESH_SECRET` is no longer required (it was never used).
4. Never run `prisma db seed` against production — it now refuses when `NODE_ENV=production`. If the seeded `Admin@123` account ever existed on your live DB, change that password now.

## What changed
| # | Review item | Fix |
|---|---|---|
| 1 | Registration token worked as a login | `JwtStrategy.validate` rejects any token carrying `type`/`purpose` (registration + KYC file-access tokens). KYC upload still works (KycAuthGuard falls back to the registration guard). |
| 2 | Suspension didn't log out | `JwtStrategy` now re-reads the user every request: suspended / REJECTED / not-yet-approved → 401 immediately (INFO_REQUESTED still allowed). `refreshToken()` checks `isActive` + KYC and revokes all tokens if blocked. `adminSetActive(false)` and password reset revoke all refresh tokens. Role/kycStatus now come from the DB, not the stale token. |
| 3 | Approval only checked on offers | New `ApprovedUserGuard` / `@RequireApproved()` (`common/guards/approved-user.guard.ts`) on all state-changing routes: products (create/edit/status/delete/media), media, testing + transport (register/update/request/book/status/report/tracking), warehouse (register/edit/book/accept/reject/cancel/complete/receipt/invoice/payment/gate-out/lien/insurance). Reads, KYC, account, and message/clarification replies stay open so INFO_REQUESTED users can answer the admin. |
| 4 | Dev OTP in production | Boot refused in production unless `ALLOW_INSECURE_DEV_OTP=true`. OTPs and temp passwords use `crypto.randomInt`. |
| 5 | OTP attempt limit ineffective | Failed guesses counted per OTP (`attempts`), locked at 5; only the newest code is valid; max 5 code requests / 15 min per account; constant-time compare. |
| 6 | Forgot-password reveals accounts | Always the same generic response; `verifyOtp` / `resetPassword` return "Invalid or expired OTP" for unknown users; login no longer reveals "suspended" without the right password. |
| 7 | Plain-text refresh tokens | 384-bit random tokens, stored hashed. (Reuse-detection is deferred to Milestone 4 — it needs a `revokedAt` column to tell rotation from logout, and is unsafe without it.) |
| 8 | Product detail leaked PENDING/REJECTED/REMOVED | `GET /products/:id` only serves ACTIVE / UNDER_OFFER / SOLD to the public; owner, ADMIN/MODERATOR, or a buyer with an offer can open others. Same 404 as "not found". Owner views no longer bump `viewCount`. |
| 9 | Swagger public / seed password | See deploy step 3–4. |
| + | **Extra finding:** `GET /products/:id` returned the seller's full `UserProfile` publicly (CNIC, date of birth, address, NTN, bank account, IBAN) | Now selects only name, business name, city, province, photo, farm location. |
| + | Frontend | `tryRefresh` is single-flight (parallel 401s previously raced on the rotating refresh token and could sign the user out). |

## Behaviour changes to be aware of
- A user whose status moves to REJECTED/SUBMITTED while logged in loses API access on their next request (previously until token expiry).
- `INFO_REQUESTED` users can log in and read, but any `@RequireApproved()` action returns 403 "Your account must be approved…". (Offers already behaved this way.)
- Admin-created and seeded users are APPROVED, so nothing changes for them.

## Tests (new)
`auth/jwt.strategy.spec.ts`, `auth/auth-hardening.spec.ts`, `common/guards/approved-user.guard.spec.ts`, `config/env.validation.spec.ts`, `products/products-visibility.spec.ts`, `users/users-suspend.spec.ts`.

## Not done here (by design, scheduled later)
Resend OTP / re-register for abandoned sign-ups, forgot-password screen, refresh-token reuse detection → Milestone 4. Real SMS delivery → out of scope (per your decision).
