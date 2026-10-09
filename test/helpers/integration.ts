/**
 * Shared helpers for the real-Postgres integration tests (test/*.int-spec.ts).
 * Everything here is skipped unless TEST_DATABASE_URL is set.
 *
 * The test database is throw-away (docker-compose.test.yml uses tmpfs and
 * `npm run test:integration:setup` resets the schema), so tests create rows
 * with unique tags and do not clean up after themselves. Assertions are always
 * scoped to rows the test created (by user id / order id), never global counts.
 */
import { PrismaClient } from '@prisma/client';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { SettingsService } from '../../src/settings/settings.service';
import { OffersService, OrdersService } from '../../src/offers/offers.service';
import { WarehouseService } from '../../src/warehouse/warehouse.service';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const describeDb: jest.Describe = (TEST_DB_URL ? describe : describe.skip) as any;

let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function connect() {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await prisma.$connect();
  return prisma;
}

/** The real services wired to a real PrismaClient; only S3 is faked. */
export function buildServices(prisma: PrismaClient) {
  const p = prisma as any;
  const notifications = new NotificationsService(p);
  const settings = new SettingsService(p);
  const storage: any = {
    putObject: async () => undefined,
    getPresignedUrl: async () => 'https://example.test/signed',
  };
  return {
    notifications,
    settings,
    offers: new OffersService(p, settings, notifications),
    orders: new OrdersService(p, notifications),
    warehouse: new WarehouseService(p, storage, notifications, settings),
  };
}

export async function makeUser(prisma: PrismaClient, role: string, extra: Record<string, any> = {}) {
  return prisma.user.create({
    data: {
      passwordHash: 'x',
      role: role as any,
      email: `${uniq()}@it.local`,
      kycStatus: 'APPROVED' as any,
      ...extra,
    } as any,
  });
}

export async function makeProduct(prisma: PrismaClient, sellerId: string, extra: Record<string, any> = {}) {
  return prisma.product.create({
    data: {
      sellerId,
      category: 'rice',
      name: `Rice ${uniq()}`,
      quantity: 100,
      unit: 'kg',
      askingPrice: 100,
      minOrderQty: 1,
      locationCity: 'Lahore',
      locationProvince: 'Punjab',
      status: 'ACTIVE' as any,
      ...extra,
    } as any,
  });
}

export async function makeWarehouse(prisma: PrismaClient, userId: string, extra: Record<string, any> = {}) {
  return prisma.warehouseProfile.create({
    data: {
      userId,
      name: `WH ${uniq()}`,
      type: 'DRY_STORAGE' as any,
      city: 'Lahore',
      province: 'Punjab',
      address: '1 Test Road',
      totalCapacityTons: 1000,
      pricePerTonMonth: 1000,
      minDurationDays: 1,
      commoditiesAccepted: ['Rice'],
      isActive: true,
      ...extra,
    } as any,
  });
}

export const ledger = (prisma: PrismaClient, userId: string, type?: string) =>
  prisma.transaction.findMany({ where: { userId, ...(type ? { type: type as any } : {}) } });

export const sum = (rows: { amount: any }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
