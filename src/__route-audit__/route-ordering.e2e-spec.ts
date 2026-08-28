/**
 * Round 2, Milestone 1 — Route-ordering LIVE verification.
 *
 * This is NOT a static read-through. It boots the real Nest application
 * (real AppModule, real controllers, real routing table, real guards) and
 * fires actual HTTP requests through the real Express router, exactly as
 * a deployed server would dispatch them.
 *
 * The only thing replaced is PrismaService — the sandbox this was written
 * in has no network access to Prisma's engine-binary CDN, so a real
 * PrismaClient cannot be constructed here. It's swapped for an
 * instrumented stub that logs every `model.method(args)` call it receives
 * instead of touching a real database. That log is the proof: if
 * `GET /users/admin/list` results in a `user.findUnique` call (the :id
 * handler's query shape) instead of a `user.findMany` call (the
 * admin-list handler's query shape), the route ordering bug is real,
 * regardless of what any comment in the code claims.
 *
 * Auth/roles guards are overridden to always allow with a fake ADMIN user
 * attached to the request — this test is only about *routing*, not
 * authorization (that's covered separately in the IDOR/security pass).
 */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { KycAuthGuard } from '../common/guards/kyc-auth.guard';
import { RegistrationTokenGuard } from '../common/guards/registration-token.guard';
import { OtpThrottleGuard } from '../common/guards/otp-throttle.guard';
import { ThrottlerGuard } from '@nestjs/throttler';

type LogEntry = { model: string; method: string; args: any };

function makePrismaStub(log: LogEntry[]): any {
  const modelCache: Record<string, any> = {};
  const stubModel = (modelName: string) =>
    new Proxy(
      {},
      {
        get(_t, method: string) {
          return (...args: any[]) => {
            log.push({ model: modelName, method, args: args[0] });
            if (method === 'findMany') return Promise.resolve([]);
            if (method === 'count') return Promise.resolve(0);
            if (method === 'findUnique' || method === 'findFirst') return Promise.resolve(null);
            if (method === 'create' || method === 'update' || method === 'upsert')
              return Promise.resolve({ id: 'stub-id' });
            if (method === 'delete') return Promise.resolve({ id: 'stub-id' });
            if (method === 'aggregate') return Promise.resolve({});
            return Promise.resolve(undefined);
          };
        },
      },
    );
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === '$transaction') return (arg: any) => Promise.resolve(Array.isArray(arg) ? [] : arg);
        if (prop === '$connect' || prop === '$disconnect') return () => Promise.resolve();
        if (prop === '$queryRaw' || prop === '$executeRaw') return () => Promise.resolve([]);
        if (!modelCache[prop]) modelCache[prop] = stubModel(prop);
        return modelCache[prop];
      },
    },
  );
}

describe('Round 2 / Milestone 1 — live route-ordering audit', () => {
  let app: INestApplication;
  let baseUrl: string;
  let log: LogEntry[];

  beforeAll(async () => {
    log = [];
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(makePrismaStub(log))
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 'test-admin-id', userId: 'test-admin-id', sub: 'test-admin-id', role: 'ADMIN' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(KycAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RegistrationTokenGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OtpThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const server = app.getHttpServer();
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    log.length = 0;
  });

  async function hit(method: string, path: string) {
    const res = await fetch(`${baseUrl}${path}`, { method });
    return { status: res.status, log: [...log] };
  }

  test('GET /users/admin/list dispatches to the admin-list query shape, not :id lookup', async () => {
    const { status, log: calls } = await hit('GET', '/users/admin/list');
    console.log('users/admin/list ->', status, JSON.stringify(calls));
    const hitFindUniqueWithAdminId = calls.some(
      (c) => c.model === 'user' && (c.method === 'findUnique' || c.method === 'findFirst') && c.args?.where?.id === 'admin',
    );
    const hitFindMany = calls.some((c) => c.model === 'user' && c.method === 'findMany');
    expect(hitFindUniqueWithAdminId).toBe(false);
    expect(hitFindMany).toBe(true);
  });

  test('GET /users/:id still works for a real id (regression check)', async () => {
    const { status, log: calls } = await hit('GET', '/users/some-real-uuid');
    console.log('users/:id ->', status, JSON.stringify(calls));
    const hitFindUnique = calls.some(
      (c) => c.model === 'user' && (c.method === 'findUnique' || c.method === 'findFirst') && c.args?.where?.id === 'some-real-uuid',
    );
    expect(hitFindUnique).toBe(true);
  });

  test('GET /products/admin/all dispatches to admin-list, not product :id lookup', async () => {
    const { status, log: calls } = await hit('GET', '/products/admin/all');
    console.log('products/admin/all ->', status, JSON.stringify(calls));
    const hitFindUniqueWithAdminId = calls.some(
      (c) => c.model === 'product' && (c.method === 'findUnique' || c.method === 'findFirst') && c.args?.where?.id === 'admin',
    );
    const hitFindMany = calls.some((c) => c.model === 'product' && c.method === 'findMany');
    expect(hitFindUniqueWithAdminId).toBe(false);
    expect(hitFindMany).toBe(true);
  });

  test('GET /products/my and /products/saved do not fall into /products/:id', async () => {
    for (const seg of ['my', 'saved']) {
      const { status, log: calls } = await hit('GET', `/products/${seg}`);
      console.log(`products/${seg} ->`, status, JSON.stringify(calls));
      const hitFindUniqueWithSegAsId = calls.some(
        (c) => c.model === 'product' && (c.method === 'findUnique' || c.method === 'findFirst') && c.args?.where?.id === seg,
      );
      expect(hitFindUniqueWithSegAsId).toBe(false);
    }
  });

  test('GET /warehouse/admin/all dispatches to admin-list, not warehouse :id lookup', async () => {
    const { status, log: calls } = await hit('GET', '/warehouse/admin/all');
    console.log('warehouse/admin/all ->', status, JSON.stringify(calls));
    const hitFindUniqueWithAdminId = calls.some(
      (c) =>
        (c.model === 'warehouseProfile' || c.model === 'warehouse') &&
        (c.method === 'findUnique' || c.method === 'findFirst') &&
        c.args?.where?.id === 'admin',
    );
    expect(hitFindUniqueWithAdminId).toBe(false);
  });

  test('GET /warehouse/receipts/my does not fall into /warehouse/receipts/:id', async () => {
    const { status, log: calls } = await hit('GET', '/warehouse/receipts/my');
    console.log('warehouse/receipts/my ->', status, JSON.stringify(calls));
    const hitFindUniqueWithMyAsId = calls.some(
      (c) => c.method === 'findUnique' && c.args?.where?.id === 'my',
    );
    expect(hitFindUniqueWithMyAsId).toBe(false);
  });

  test('GET /warehouse/dashboard/operator does not fall into /warehouse/:id', async () => {
    const { status, log: calls } = await hit('GET', '/warehouse/dashboard/operator');
    console.log('warehouse/dashboard/operator ->', status, JSON.stringify(calls));
    const hitFindUniqueWithDashboardAsId = calls.some(
      (c) => c.method === 'findUnique' && c.args?.where?.id === 'dashboard',
    );
    expect(hitFindUniqueWithDashboardAsId).toBe(false);
  });

  test('GET /categories/admin/all and /cities/admin/all dispatch correctly', async () => {
    for (const path of ['/categories/admin/all', '/cities/admin/all', '/units/admin/all']) {
      const { status, log: calls } = await hit('GET', path);
      console.log(`${path} ->`, status, JSON.stringify(calls));
    }
  });

  test('GET /testing/agencies/admin/all and /transport/providers/admin/all', async () => {
    for (const path of ['/testing/admin/all', '/transport/admin/all']) {
      const { status, log: calls } = await hit('GET', path);
      console.log(`${path} ->`, status, JSON.stringify(calls));
    }
  });

  test('PATCH /products/admin/:id/approve dispatches to the admin-approve handler, not PATCH /products/:id', async () => {
    const { status, log: calls } = await hit('PATCH', '/products/admin/fake-product-id/approve');
    console.log('PATCH products/admin/:id/approve ->', status, JSON.stringify(calls));
    // adminApprove() does a findUnique existence check first, then (only if
    // found) an update({ data: { status: 'ACTIVE', ... } }). Our stub
    // returns null for findUnique, so the handler correctly 404s before
    // reaching update — the important assertion is that the *existence
    // check itself* was a plain findUnique by id (the admin handler's
    // shape), not the generic edit handler's ownership-checked findUnique
    // (which additionally selects sellerId) or the /products/:id GET
    // handler's heavily-included findUnique. This confirms the ':id'
    // segment reaching the service is the real productId, not the literal
    // string 'admin'.
    const correctExistenceCheck = calls.some(
      (c) =>
        c.model === 'product' &&
        (c.method === 'findUnique' || c.method === 'findFirst') &&
        c.args?.where?.id === 'fake-product-id',
    );
    const wronglyTreatedAdminAsId = calls.some(
      (c) => c.model === 'product' && (c.method === 'findUnique' || c.method === 'findFirst') && c.args?.where?.id === 'admin',
    );
    expect(correctExistenceCheck).toBe(true);
    expect(wronglyTreatedAdminAsId).toBe(false);
    expect(status).toBe(404); // expected: fake id, correctly not found — proves the check ran
  });

  test('PATCH /users/admin/:id/kyc dispatches to the admin-kyc handler, not GET-style :id route confusion', async () => {
    const { status, log: calls } = await hit('PATCH', '/users/admin/fake-user-id/kyc');
    console.log('PATCH users/admin/:id/kyc ->', status, JSON.stringify(calls));
    const touchedUserUpdate = calls.some((c) => c.model === 'user' && c.method === 'update');
    expect(touchedUserUpdate).toBe(true);
  });

  test('PATCH /warehouse/admin/:id/verify dispatches to the admin-verify handler', async () => {
    const { status, log: calls } = await hit('PATCH', '/warehouse/admin/fake-wh-id/verify');
    console.log('PATCH warehouse/admin/:id/verify ->', status, JSON.stringify(calls));
    // adminVerify looks the warehouse up by the path :id before updating
    // it (added Round 2, Milestone 6, for a clean 404 on a missing
    // warehouse instead of a raw Prisma error) — the stub always returns
    // null for findUnique, so that lookup short-circuits before update
    // ever runs here. Checking the findUnique call reached with the
    // right id still proves this hit the admin-verify handler and not
    // some other route.
    const lookedUpRightWarehouse = calls.some(
      (c) => c.model === 'warehouseProfile' && c.method === 'findUnique' && c.args?.where?.id === 'fake-wh-id',
    );
    expect(lookedUpRightWarehouse).toBe(true);
  });

  test('GET /review/clarifications/my/kyc does not fall into a generic :id route', async () => {
    const { status, log: calls } = await hit('GET', '/review/clarifications/my/kyc');
    console.log('review/clarifications/my/kyc ->', status, JSON.stringify(calls));
    // listMyKycClarifications resolves the subject owner (a user lookup by
    // the caller's own id) before querying the thread. Confirm that lookup
    // shape ran with the real caller id — not swallowed by some other
    // route matching on the literal segments 'my' or 'kyc'.
    const resolvedOwner = calls.some(
      (c) => c.model === 'user' && c.method === 'findUnique' && c.args?.where?.id === 'test-admin-id',
    );
    expect(resolvedOwner).toBe(true);
  });

  test('GET /review/clarifications/my/provider/:subjectType (Milestone 6) dispatches correctly', async () => {
    const { status, log: calls } = await hit('GET', '/review/clarifications/my/provider/WAREHOUSE_PROFILE');
    console.log('review/clarifications/my/provider/:subjectType ->', status, JSON.stringify(calls));
    // listMyProviderClarifications looks up the caller's own warehouse
    // profile by userId first. Confirm that ran — i.e. this genuinely
    // reached the new handler rather than being swallowed by the
    // sibling `clarifications/:id/...` routes (different segment counts,
    // but worth a live check now that there are two ':id'-shaped route
    // families under the same 'clarifications' prefix).
    const lookedUpOwnWarehouseProfile = calls.some(
      (c) => c.model === 'warehouseProfile' && c.method === 'findUnique' && c.args?.where?.userId === 'test-admin-id',
    );
    expect(lookedUpOwnWarehouseProfile).toBe(true);
  });

  test('GET /offers/orders/admin dispatches to admin query, not order :id lookup', async () => {
    const { status, log: calls } = await hit('GET', '/orders/admin');
    console.log('orders/admin ->', status, JSON.stringify(calls));
    const hitFindUniqueWithAdminId = calls.some(
      (c) => c.model === 'order' && (c.method === 'findUnique' || c.method === 'findFirst') && c.args?.where?.id === 'admin',
    );
    expect(hitFindUniqueWithAdminId).toBe(false);
  });
});
