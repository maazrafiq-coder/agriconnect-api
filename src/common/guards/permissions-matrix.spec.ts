// Permissions matrix (automated).
//
// Walks EVERY controller route and checks its guards from the real Nest
// metadata, so a new state-changing route that forgets @RequireApproved()
// (or a role guard) fails CI instead of silently becoming reachable by a
// not-yet-approved account.
//
// Rule: any POST/PUT/PATCH/DELETE must be one of
//   (a) ApprovedUserGuard  - transactional; APPROVED accounts only
//   (b) RolesGuard         - staff-only routes
//   (c) an explicit entry in LIMITED_SESSION_MUTATIONS below - account /
//       KYC / clarification / chat actions that a pending, rejected or
//       info-requested user legitimately needs, or pre-login auth routes.
// Adding to (c) is a deliberate, reviewed decision.
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ApprovedUserGuard } from './approved-user.guard';
import { RolesGuard } from './roles.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { KycAuthGuard } from './kyc-auth.guard';
import { AdminReviewController } from '../../admin-review/admin-review.controller';
import { AuditController } from '../../audit/audit.controller';
import { AuthController } from '../../auth/auth.controller';
import { CitiesController, UnitsController } from '../../catalog/catalog.controller';
import { CategoriesController } from '../../categories/categories.controller';
import { MediaController } from '../../media/media.controller';
import { NotificationsController } from '../../notifications/notifications.controller';
import { OffersController, } from '../../offers/offers.controller';
import { OrdersController } from '../../offers/orders.controller';
import { SellerInvoicesController } from '../../offers/seller-invoices.controller';
import { ProductsController } from '../../products/products.controller';
import { ReviewController } from '../../review/review.controller';
import { SettingsController } from '../../settings/settings.controller';
import { TestingController, TransportController } from '../../testing/testing.controller';
import {
  TransportLifecycleController, TransportDisputesController, TransportAdminDisputesController, TransportInvoicesController,
} from '../../transport/transport.controller';
import { UsersController } from '../../users/users.controller';
import { WarehouseController } from '../../warehouse/warehouse.controller';

const CONTROLLERS: any[] = [
  AdminReviewController, AuditController, AuthController, CitiesController, UnitsController, CategoriesController,
  MediaController, NotificationsController, OffersController, OrdersController, SellerInvoicesController, ProductsController, ReviewController,
  SettingsController, TestingController, TransportController, UsersController, WarehouseController,
  TransportLifecycleController, TransportDisputesController, TransportAdminDisputesController, TransportInvoicesController,
];

// "<ControllerName> <METHOD> <handlerName>" - reviewed exceptions.
const LIMITED_SESSION_MUTATIONS = new Set<string>([
  // pre-login / session lifecycle
  'AuthController POST register', 'AuthController POST resendOtp', 'AuthController POST verifyOtp',
  'AuthController POST login', 'AuthController POST refresh', 'AuthController POST logout',
  'AuthController POST forgotPassword', 'AuthController POST resetPassword',
  // own account + KYC documents (a pending / rejected user must be able to fix these)
  'AuthController POST submitKyc', 'AuthController POST changePassword', 'AuthController POST deactivateSelf',
  'UsersController PATCH updateProfile',
  // answering the admin's clarification request
  'ReviewController POST respond',
  // own notifications
  'NotificationsController PATCH markAllRead', 'NotificationsController PATCH markRead',
  // bookmarking a public listing is browsing, not a transaction
  'ProductsController POST save',
  // chat on a booking the caller already owns - ownership is enforced in the service
  'WarehouseController POST postBookingMessage',
]);

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH', [RequestMethod.DELETE]: 'DELETE',
};

function routes() {
  const out: Array<{ ctrl: string; handler: string; method: string; path: string; guards: any[]; roles: string[] }> = [];
  for (const C of CONTROLLERS) {
    const classGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, C) || [];
    const base = Reflect.getMetadata(PATH_METADATA, C);
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      if (name === 'constructor') continue;
      const fn = C.prototype[name];
      const m = Reflect.getMetadata(METHOD_METADATA, fn);
      if (m === undefined) continue;
      const methodGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, fn) || [];
      out.push({
        ctrl: C.name, handler: name, method: METHOD_NAME[m] || String(m),
        roles: (Reflect.getMetadata('roles', fn) || Reflect.getMetadata('roles', C) || []) as string[],
        path: `/${base}/${Reflect.getMetadata(PATH_METADATA, fn)}`.replace(/\/+/g, '/'),
        guards: [...classGuards, ...methodGuards],
      });
    }
  }
  return out;
}

describe('permissions matrix', () => {
  const all = routes();

  it('discovers the routes', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  const mutating = all.filter((r) => r.method !== 'GET');

  it.each(mutating.map((r) => [`${r.ctrl} ${r.method} ${r.handler} (${r.path})`, r] as const))(
    '%s is gated',
    (_label, r) => {
      const key = `${r.ctrl} ${r.method} ${r.handler}`;
      const approved = r.guards.includes(ApprovedUserGuard);
      const staff = r.guards.includes(RolesGuard);
      const reviewed = LIMITED_SESSION_MUTATIONS.has(key);
      expect({ key, ok: approved || staff || reviewed }).toEqual({ key, ok: true });
    },
  );

  it('every reviewed exception still exists (no stale allowlist entries)', () => {
    const keys = new Set(mutating.map((r) => `${r.ctrl} ${r.method} ${r.handler}`));
    const stale = [...LIMITED_SESSION_MUTATIONS].filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it('the exception list contains no transactional route', () => {
    const forbidden = /offer|order|book|invoice|lien|insurance|quote|listing|product(?!s.*save)/i;
    const bad = [...LIMITED_SESSION_MUTATIONS].filter((k) => forbidden.test(k.split(' ').slice(2).join(' ')) && !/postBookingMessage|ProductsController POST save/.test(k));
    expect(bad).toEqual([]);
  });

  it('staff-only (RolesGuard) routes also authenticate first', () => {
    const bad = all.filter((r) => r.guards.includes(RolesGuard) && !r.guards.some((g) => g === JwtAuthGuard || g === ApprovedUserGuard || g === KycAuthGuard));
    expect(bad.map((r) => `${r.ctrl} ${r.handler}`)).toEqual([]);
  });

  it('offer and order mutations are APPROVED-only', () => {
    const must = mutating.filter((r) => ['OffersController', 'OrdersController'].includes(r.ctrl) && !r.path.includes('/admin/'));
    expect(must.length).toBeGreaterThan(5);
    for (const r of must) expect([r.handler, r.guards.includes(ApprovedUserGuard)]).toEqual([r.handler, true]);
  });
});

// `WRITE_MATRIX=1 npx jest permissions-matrix` regenerates docs/PERMISSIONS_MATRIX.md
// from the live metadata, so the document can never drift from the code.
(process.env.WRITE_MATRIX ? describe : describe.skip)('write permissions matrix document', () => {
  it('writes docs/PERMISSIONS_MATRIX.md', () => {
    const rows = routes().map((r) => {
      const key = `${r.ctrl} ${r.method} ${r.handler}`;
      const access = r.guards.includes(ApprovedUserGuard)
        ? 'APPROVED account'
        : r.guards.includes(RolesGuard)
          ? `Staff: ${r.roles.join(', ') || '(see RolesGuard)'}`
          : LIMITED_SESSION_MUTATIONS.has(key)
            ? 'Pre-login or own-account action (reviewed exception)'
            : r.method === 'GET'
              ? (r.guards.length ? 'Any logged-in session (read)' : 'Public / token')
              : 'UNGATED';
      return `| ${r.method} | \`${r.path}\` | ${r.ctrl.replace('Controller', '')} | ${access} |`;
    });
    const doc = [
      '# Permissions matrix (generated)',
      '',
      'Account states: **APPROVED** can transact. **SUBMITTED / RECOMMENDED / INFO_REQUESTED / REJECTED** hold a *limited* session: browse public listings, see account/KYC status, upload documents, answer admin clarifications. **PENDING** (OTP not verified) and suspended accounts have no session.',
      '',
      '| Verb | Route | Module | Who may call |',
      '|---|---|---|---|',
      ...rows,
      '',
    ].join('\n');
    const dir = path.join(__dirname, '..', '..', '..', 'docs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PERMISSIONS_MATRIX.md'), doc);
  });
});
