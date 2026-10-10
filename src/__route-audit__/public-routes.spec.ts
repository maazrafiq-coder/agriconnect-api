/**
 * Round 3 M9 — pins the set of routes reachable WITHOUT a login.
 * Reads Nest's own decorator metadata (no DB, no HTTP). If you add a route
 * and forget a guard it will show up here as an unexpected public route; if
 * it is meant to be public, add it to EXPECTED_PUBLIC with a reason.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? controllerFiles(p) : p.endsWith('.controller.ts') ? [p] : [];
  });
}

// ApprovedUserGuard extends JwtAuthGuard; RegistrationTokenGuard checks the short-lived post-register token.
const AUTH_GUARDS = ['JwtAuthGuard', 'KycAuthGuard', 'ApprovedUserGuard', 'RegistrationTokenGuard'];
const guardNames = (target: any): string[] =>
  (Reflect.getMetadata('__guards__', target) || []).map((g: any) => g?.name);

export function collectPublicRoutes(): string[] {
  const out: string[] = [];
  for (const file of controllerFiles(join(__dirname, '..'))) {
    const mod = require(file);
    for (const Ctrl of Object.values<any>(mod)) {
      if (typeof Ctrl !== 'function' || Reflect.getMetadata('path', Ctrl) === undefined) continue;
      const base = String(Reflect.getMetadata('path', Ctrl));
      const classGuards = guardNames(Ctrl);
      for (const key of Object.getOwnPropertyNames(Ctrl.prototype)) {
        const handler = Ctrl.prototype[key];
        if (typeof handler !== 'function' || key === 'constructor') continue;
        const method = Reflect.getMetadata('method', handler);
        if (method === undefined) continue;
        const guards = [...classGuards, ...guardNames(handler)];
        if (guards.some((g) => AUTH_GUARDS.includes(g))) continue;
        const sub = String(Reflect.getMetadata('path', handler));
        out.push(`${RequestMethod[method]} /${[base, sub === '/' ? '' : sub].filter(Boolean).join('/')}`);
      }
    }
  }
  return out.sort();
}

// Every entry is deliberate. Reason in the comment.
const EXPECTED_PUBLIC = [
  // auth flow (pre-login by definition)
  'POST /auth/register', 'POST /auth/resend-otp', 'POST /auth/login', 'POST /auth/refresh',
  'POST /auth/forgot-password', 'POST /auth/reset-password',
  // signed-token file download (token is the credential)
  'GET /auth/kyc/documents/file/:token', 'GET /review/clarifications/attachments/file/:token',
  // public marketplace browsing
  'GET /cities', 'GET /units', 'GET /categories', 'GET /products', 'GET /products/seller/:sellerId',
  // OptionalJwtAuthGuard: anonymous allowed, logged-in users get extras
  'GET /products/:id',
  // pre-login step of registration; throttled per identifier (OtpThrottleGuard)
  'POST /auth/verify-otp',
  // rate preview before booking; read-only
  'GET /warehouse/:id/quote',
  'GET /users/:id', 'GET /media/:entityType/:entityId',
  'GET /warehouse', 'GET /warehouse/:id', 'GET /public/stats',
  'GET /testing/agencies', 'GET /transport/providers',
  // shipment tracking by unguessable id
  'GET /transport/track/:id',
  // probes
  'GET /health', 'GET /health/live', 'GET /health/ready',
];

describe('public (unauthenticated) routes', () => {
  it('are exactly the expected allowlist', () => {
    const actual = collectPublicRoutes();
    const unexpected = actual.filter((r) => !EXPECTED_PUBLIC.includes(r));
    const missing = EXPECTED_PUBLIC.filter((r) => !actual.includes(r));
    expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });
  });
});
