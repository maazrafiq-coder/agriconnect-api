# Permissions matrix (generated)

Account states: **APPROVED** can transact. **SUBMITTED / RECOMMENDED / INFO_REQUESTED / REJECTED** hold a *limited* session: browse public listings, see account/KYC status, upload documents, answer admin clarifications. **PENDING** (OTP not verified) and suspended accounts have no session.

| Verb | Route | Module | Who may call |
|---|---|---|---|
| GET | `/admin-review/:type/:id` | AdminReview | Staff: ADMIN, MODERATOR |
| GET | `/audit/admin` | Audit | Staff: ADMIN |
| POST | `/auth/register` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/resend-otp` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/verify-otp` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/login` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/refresh` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/logout` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/kyc/submit` | Auth | Pre-login or own-account action (reviewed exception) |
| GET | `/auth/kyc/status` | Auth | Any logged-in session (read) |
| GET | `/auth/kyc/documents/:docId/signed-url` | Auth | Any logged-in session (read) |
| GET | `/auth/kyc/documents/file/:token` | Auth | Public / token |
| POST | `/auth/forgot-password` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/reset-password` | Auth | Pre-login or own-account action (reviewed exception) |
| GET | `/auth/me` | Auth | Any logged-in session (read) |
| POST | `/auth/change-password` | Auth | Pre-login or own-account action (reviewed exception) |
| POST | `/auth/deactivate-self` | Auth | Pre-login or own-account action (reviewed exception) |
| GET | `/auth/my-documents` | Auth | Any logged-in session (read) |
| GET | `/auth/my-activity` | Auth | Any logged-in session (read) |
| POST | `/auth/admin/create-user` | Auth | Staff: ADMIN |
| POST | `/auth/admin/:userId/reset-password` | Auth | Staff: ADMIN |
| POST | `/auth/moderator/:userId/recommend` | Auth | Staff: ADMIN, MODERATOR |
| GET | `/cities/` | Cities | Public / token |
| GET | `/cities/admin/all` | Cities | Staff: ADMIN |
| POST | `/cities/admin` | Cities | Staff: ADMIN |
| PATCH | `/cities/admin/:id` | Cities | Staff: ADMIN |
| PATCH | `/cities/admin/:id/deactivate` | Cities | Staff: ADMIN |
| PATCH | `/cities/admin/:id/reactivate` | Cities | Staff: ADMIN |
| GET | `/units/` | Units | Public / token |
| GET | `/units/admin/all` | Units | Staff: ADMIN |
| POST | `/units/admin` | Units | Staff: ADMIN |
| PATCH | `/units/admin/:id` | Units | Staff: ADMIN |
| PATCH | `/units/admin/:id/deactivate` | Units | Staff: ADMIN |
| PATCH | `/units/admin/:id/reactivate` | Units | Staff: ADMIN |
| GET | `/categories/` | Categories | Public / token |
| GET | `/categories/admin/all` | Categories | Staff: ADMIN |
| POST | `/categories/admin` | Categories | Staff: ADMIN |
| PATCH | `/categories/admin/:id` | Categories | Staff: ADMIN |
| PATCH | `/categories/admin/:id/deactivate` | Categories | Staff: ADMIN |
| PATCH | `/categories/admin/:id/reactivate` | Categories | Staff: ADMIN |
| GET | `/media/:entityType/:entityId` | Media | Public / token |
| POST | `/media/:entityType/:entityId` | Media | APPROVED account |
| PATCH | `/media/:id/set-primary` | Media | APPROVED account |
| DELETE | `/media/:id` | Media | APPROVED account |
| GET | `/notifications/` | Notifications | Any logged-in session (read) |
| GET | `/notifications/unread-count` | Notifications | Any logged-in session (read) |
| PATCH | `/notifications/read-all` | Notifications | Pre-login or own-account action (reviewed exception) |
| PATCH | `/notifications/:id/read` | Notifications | Pre-login or own-account action (reviewed exception) |
| POST | `/offers/` | Offers | APPROVED account |
| POST | `/offers/terms/preview` | Offers | APPROVED account |
| GET | `/offers/received` | Offers | Any logged-in session (read) |
| GET | `/offers/sent` | Offers | Any logged-in session (read) |
| PATCH | `/offers/:id/accept` | Offers | APPROVED account |
| PATCH | `/offers/:id/accept-counter` | Offers | APPROVED account |
| PATCH | `/offers/:id/withdraw` | Offers | APPROVED account |
| PATCH | `/offers/:id/reject` | Offers | APPROVED account |
| PATCH | `/offers/:id/counter` | Offers | APPROVED account |
| POST | `/offers/:id/rounds` | Offers | APPROVED account |
| GET | `/offers/:id/rounds` | Offers | Any logged-in session (read) |
| GET | `/offers/:id/messages` | Offers | Any logged-in session (read) |
| POST | `/offers/:id/messages` | Offers | APPROVED account |
| GET | `/orders/` | Orders | Any logged-in session (read) |
| GET | `/orders/admin/summary` | Orders | Staff: ADMIN |
| GET | `/orders/admin` | Orders | Staff: ADMIN |
| GET | `/orders/:id` | Orders | Any logged-in session (read) |
| PATCH | `/orders/:id/status` | Orders | APPROVED account |
| PATCH | `/orders/admin/:id/resolve-dispute` | Orders | Staff: ADMIN |
| GET | `/invoices/my` | SellerInvoices | Any logged-in session (read) |
| GET | `/invoices/issued` | SellerInvoices | Any logged-in session (read) |
| GET | `/invoices/order/:orderId` | SellerInvoices | Any logged-in session (read) |
| POST | `/invoices/order/:orderId` | SellerInvoices | APPROVED account |
| GET | `/invoices/:id` | SellerInvoices | Any logged-in session (read) |
| POST | `/invoices/:id/submit-payment` | SellerInvoices | APPROVED account |
| POST | `/invoices/:id/confirm-payment` | SellerInvoices | APPROVED account |
| POST | `/invoices/:id/reject-payment` | SellerInvoices | APPROVED account |
| POST | `/invoices/:id/void` | SellerInvoices | APPROVED account |
| POST | `/invoices/:id/replace` | SellerInvoices | APPROVED account |
| GET | `/products/` | Products | Public / token |
| GET | `/products/my` | Products | Any logged-in session (read) |
| GET | `/products/saved` | Products | Any logged-in session (read) |
| DELETE | `/products/:id` | Products | APPROVED account |
| GET | `/products/seller/:sellerId` | Products | Public / token |
| GET | `/products/:id` | Products | Any logged-in session (read) |
| POST | `/products/` | Products | APPROVED account |
| PATCH | `/products/:id` | Products | APPROVED account |
| PATCH | `/products/:id/status` | Products | APPROVED account |
| POST | `/products/:id/media` | Products | APPROVED account |
| PATCH | `/products/media/:mediaId/set-primary` | Products | APPROVED account |
| POST | `/products/:id/save` | Products | Pre-login or own-account action (reviewed exception) |
| GET | `/products/admin/all` | Products | Staff: ADMIN |
| PATCH | `/products/admin/:id/approve` | Products | Staff: ADMIN |
| PATCH | `/products/admin/:id/reject` | Products | Staff: ADMIN |
| PATCH | `/products/admin/:id/remove` | Products | Staff: ADMIN |
| PATCH | `/products/admin/:id/restore` | Products | Staff: ADMIN |
| POST | `/review/clarifications` | Review | Staff: ADMIN, MODERATOR |
| GET | `/review/clarifications` | Review | Any logged-in session (read) |
| GET | `/review/clarifications/my/kyc` | Review | Any logged-in session (read) |
| GET | `/review/clarifications/my/provider/:subjectType` | Review | Any logged-in session (read) |
| POST | `/review/clarifications/:id/respond` | Review | Pre-login or own-account action (reviewed exception) |
| PATCH | `/review/clarifications/:id/resolve` | Review | Staff: ADMIN, MODERATOR |
| GET | `/review/clarifications/:id/attachments/:attId/signed-url` | Review | Any logged-in session (read) |
| GET | `/review/clarifications/attachments/file/:token` | Review | Public / token |
| GET | `/settings/admin/` | Settings | Staff: ADMIN |
| PUT | `/settings/admin/platform-fee` | Settings | Staff: ADMIN |
| PUT | `/settings/admin/commodity-prices` | Settings | Staff: ADMIN |
| DELETE | `/settings/admin/commodity-prices/:commodity` | Settings | Staff: ADMIN |
| GET | `/testing/agencies` | Testing | Public / token |
| POST | `/testing/register` | Testing | APPROVED account |
| GET | `/testing/my-agency` | Testing | Any logged-in session (read) |
| PATCH | `/testing/my-agency` | Testing | APPROVED account |
| POST | `/testing/requests` | Testing | APPROVED account |
| GET | `/testing/requests/my` | Testing | Any logged-in session (read) |
| PATCH | `/testing/requests/:id/status` | Testing | APPROVED account |
| POST | `/testing/requests/:id/report` | Testing | APPROVED account |
| POST | `/testing/requests/:id/report-file` | Testing | APPROVED account |
| GET | `/testing/requests/:id/report-file` | Testing | Any logged-in session (read) |
| GET | `/testing/admin/all` | Testing | Staff: ADMIN |
| PATCH | `/testing/admin/:id/active` | Testing | Staff: ADMIN |
| PATCH | `/testing/admin/:id/verify` | Testing | Staff: ADMIN |
| GET | `/transport/providers` | Transport | Public / token |
| POST | `/transport/register` | Transport | APPROVED account |
| GET | `/transport/my-provider` | Transport | Any logged-in session (read) |
| PATCH | `/transport/my-provider` | Transport | APPROVED account |
| POST | `/transport/requests` | Transport | APPROVED account |
| POST | `/transport/book` | Transport | APPROVED account |
| GET | `/transport/admin/all` | Transport | Staff: ADMIN |
| PATCH | `/transport/admin/:id/active` | Transport | Staff: ADMIN |
| PATCH | `/transport/admin/:id/verify` | Transport | Staff: ADMIN |
| GET | `/users/profile` | Users | Any logged-in session (read) |
| PATCH | `/users/profile` | Users | Pre-login or own-account action (reviewed exception) |
| GET | `/users/:id` | Users | Public / token |
| GET | `/users/admin/list` | Users | Staff: ADMIN, MODERATOR |
| GET | `/users/admin/:id/detail` | Users | Staff: ADMIN, MODERATOR |
| PATCH | `/users/admin/:id/kyc` | Users | Staff: ADMIN |
| PATCH | `/users/admin/:id/active` | Users | Staff: ADMIN |
| GET | `/warehouse/` | Warehouse | Public / token |
| GET | `/warehouse/:id` | Warehouse | Public / token |
| POST | `/warehouse/register` | Warehouse | APPROVED account |
| PATCH | `/warehouse/:id` | Warehouse | APPROVED account |
| GET | `/warehouse/:id/quote` | Warehouse | Public / token |
| POST | `/warehouse/book` | Warehouse | APPROVED account |
| GET | `/warehouse/bookings/my` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/bookings/:id` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/bookings/:id/messages` | Warehouse | Any logged-in session (read) |
| POST | `/warehouse/bookings/:id/messages` | Warehouse | Pre-login or own-account action (reviewed exception) |
| PATCH | `/warehouse/bookings/:id/accept` | Warehouse | APPROVED account |
| PATCH | `/warehouse/bookings/:id/reject` | Warehouse | APPROVED account |
| PATCH | `/warehouse/bookings/:id/cancel` | Warehouse | APPROVED account |
| PATCH | `/warehouse/bookings/:id/complete` | Warehouse | APPROVED account |
| GET | `/warehouse/receipts/my` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/receipts/:id` | Warehouse | Any logged-in session (read) |
| POST | `/warehouse/receipts/issue/:bookingId` | Warehouse | APPROVED account |
| POST | `/warehouse/bookings/:bookingId/invoice` | Warehouse | APPROVED account |
| GET | `/warehouse/invoices/my` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/invoices/operator` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/invoices/:id` | Warehouse | Any logged-in session (read) |
| PATCH | `/warehouse/invoices/:id/confirm-payment` | Warehouse | APPROVED account |
| GET | `/warehouse/grn/:id` | Warehouse | Any logged-in session (read) |
| POST | `/warehouse/bookings/:bookingId/gate-out-request` | Warehouse | APPROVED account |
| GET | `/warehouse/gate-out/my` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/gate-out/operator` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/gate-out/:id` | Warehouse | Any logged-in session (read) |
| PATCH | `/warehouse/gate-out/:id/approve` | Warehouse | APPROVED account |
| PATCH | `/warehouse/gate-out/:id/reject` | Warehouse | APPROVED account |
| POST | `/warehouse/lien/apply` | Warehouse | APPROVED account |
| PATCH | `/warehouse/lien/:id/withdraw` | Warehouse | APPROVED account |
| PATCH | `/warehouse/lien/:id/release` | Warehouse | APPROVED account |
| GET | `/warehouse/insurance/quote/:receiptId` | Warehouse | Any logged-in session (read) |
| POST | `/warehouse/insurance/buy` | Warehouse | APPROVED account |
| GET | `/warehouse/dashboard/operator` | Warehouse | Any logged-in session (read) |
| GET | `/warehouse/admin/all` | Warehouse | Staff: ADMIN |
| GET | `/warehouse/admin/liens` | Warehouse | Staff: ADMIN, MODERATOR |
| PATCH | `/warehouse/admin/liens/:id/confirm` | Warehouse | Staff: ADMIN, MODERATOR |
| PATCH | `/warehouse/admin/liens/:id/reject` | Warehouse | Staff: ADMIN, MODERATOR |
| PATCH | `/warehouse/admin/:id/verify` | Warehouse | Staff: ADMIN |
| PATCH | `/warehouse/admin/:id/active` | Warehouse | Staff: ADMIN |
| GET | `/transport/requests/my` | TransportLifecycle | Any logged-in session (read) |
| GET | `/transport/requests/:id` | TransportLifecycle | Any logged-in session (read) |
| PATCH | `/transport/requests/:id/quote` | TransportLifecycle | APPROVED account |
| PATCH | `/transport/requests/:id/counter` | TransportLifecycle | APPROVED account |
| PATCH | `/transport/requests/:id/accept` | TransportLifecycle | APPROVED account |
| PATCH | `/transport/requests/:id/reject-quote` | TransportLifecycle | APPROVED account |
| PATCH | `/transport/requests/:id/decline` | TransportLifecycle | APPROVED account |
| PATCH | `/transport/requests/:id/cancel` | TransportLifecycle | APPROVED account |
| PATCH | `/transport/requests/:id/tracking` | TransportLifecycle | APPROVED account |
| POST | `/transport/requests/:id/acknowledge` | TransportLifecycle | APPROVED account |
| GET | `/transport/track/:id` | TransportLifecycle | Public / token |
| GET | `/transport/disputes/my` | TransportDisputes | Any logged-in session (read) |
| POST | `/transport/disputes/request/:requestId` | TransportDisputes | APPROVED account |
| GET | `/transport/disputes/:id` | TransportDisputes | Any logged-in session (read) |
| POST | `/transport/disputes/:id/respond` | TransportDisputes | APPROVED account |
| POST | `/transport/disputes/:id/withdraw` | TransportDisputes | APPROVED account |
| GET | `/transport/admin/disputes/` | TransportAdminDisputes | Staff: ADMIN, MODERATOR |
| POST | `/transport/admin/disputes/:id/resolve` | TransportAdminDisputes | Staff: ADMIN |
| GET | `/transport-invoices/my` | TransportInvoices | Any logged-in session (read) |
| GET | `/transport-invoices/issued` | TransportInvoices | Any logged-in session (read) |
| GET | `/transport-invoices/request/:requestId` | TransportInvoices | Any logged-in session (read) |
| POST | `/transport-invoices/request/:requestId` | TransportInvoices | APPROVED account |
| GET | `/transport-invoices/:id` | TransportInvoices | Any logged-in session (read) |
| POST | `/transport-invoices/:id/submit-payment` | TransportInvoices | APPROVED account |
| POST | `/transport-invoices/:id/confirm-payment` | TransportInvoices | APPROVED account |
| POST | `/transport-invoices/:id/reject-payment` | TransportInvoices | APPROVED account |
| POST | `/transport-invoices/:id/void` | TransportInvoices | APPROVED account |
| POST | `/transport-invoices/:id/replace` | TransportInvoices | APPROVED account |
