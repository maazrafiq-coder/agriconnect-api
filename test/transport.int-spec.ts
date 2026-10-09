/**
 * Integration tests against a REAL Postgres (not stubs).
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npm run test:integration
 *
 * Skipped automatically when TEST_DATABASE_URL is not set, so the normal
 * `npm test` never needs a database. These run in CI against a throw-away DB;
 * they could not be executed in the authoring sandbox (no Postgres / Prisma
 * engine download), so treat the first CI run as their first real run.
 */
import { PrismaClient } from '@prisma/client';
import { TransportService } from '../src/testing/testing.service';
import { NotificationsService } from '../src/notifications/notifications.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('Transport quote → accept → track (real database)', () => {
  let prisma: PrismaClient;
  let service: TransportService;
  let buyerId: string;
  let providerId: string;
  const tag = `it-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new TransportService(prisma as any, new NotificationsService(prisma as any));
    const buyer = await prisma.user.create({ data: { passwordHash: 'x', role: 'BUYER', email: `${tag}-b@test.local` } as any });
    const prov = await prisma.user.create({ data: { passwordHash: 'x', role: 'TRANSPORTER', email: `${tag}-p@test.local` } as any });
    buyerId = buyer.id; providerId = prov.id;
    await prisma.transportProfile.create({ data: { userId: providerId, companyName: 'IT Logistics', maxCapacityTons: 20, pricePerKm: 100 } as any });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [buyerId, providerId] } } });
    await prisma.transportRequest.deleteMany({ where: { requesterId: buyerId } });
    await prisma.transportProfile.deleteMany({ where: { userId: providerId } });
    await prisma.user.deleteMany({ where: { id: { in: [buyerId, providerId] } } });
    await prisma.$disconnect();
  });

  const newRequest = async () => {
    const r: any = await service.createRequest(buyerId, { pickupLocation: 'A', pickupCity: 'Lahore', deliveryLocation: 'B', deliveryCity: 'Karachi', providerId } as any);
    return r.id as string;
  };

  it('runs the full lifecycle and fixes the price at the quote', async () => {
    const id = await newRequest();
    await service.quote(id, providerId, { price: 45000 } as any);
    await service.acceptQuote(id, buyerId);
    let row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('BOOKED');
    expect(Number(row?.agreedPrice)).toBe(45000);

    await service.updateTracking(id, providerId, { status: 'PICKED_UP', currentLocation: 'Lahore' } as any);
    await service.updateTracking(id, providerId, { status: 'IN_TRANSIT' } as any);
    await service.updateTracking(id, providerId, { status: 'DELIVERED' } as any);
    row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('DELIVERED');
    expect(row?.deliveredAt).toBeTruthy();

    const notes = await prisma.notification.count({ where: { userId: buyerId, type: 'TRANSPORT_UPDATE' as any } });
    expect(notes).toBeGreaterThanOrEqual(3);
  });

  it('two simultaneous accepts book it exactly once', async () => {
    const id = await newRequest();
    await service.quote(id, providerId, { price: 30000 } as any);
    const results = await Promise.allSettled([service.acceptQuote(id, buyerId), service.acceptQuote(id, buyerId)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('BOOKED');
  });

  it('a re-quote after acceptance is refused and cannot change the agreed price', async () => {
    const id = await newRequest();
    await service.quote(id, providerId, { price: 10000 } as any);
    await service.acceptQuote(id, buyerId);
    await expect(service.quote(id, providerId, { price: 99999 } as any)).rejects.toThrow();
    const row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(Number(row?.agreedPrice)).toBe(10000);
  });
});
