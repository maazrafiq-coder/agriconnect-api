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
import { TransportLifecycleService } from '../src/transport/transport-lifecycle.service';
import { NotificationsService } from '../src/notifications/notifications.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('Transport quote → accept → track (real database)', () => {
  let prisma: PrismaClient;
  let service: TransportService;
  let life: TransportLifecycleService;
  let buyerId: string;
  let providerId: string;
  const tag = `it-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    const notes = new NotificationsService(prisma as any);
    service = new TransportService(prisma as any, notes);
    life = new TransportLifecycleService(prisma as any, notes);
    const buyer = await prisma.user.create({ data: { passwordHash: 'x', role: 'BUYER', kycStatus: 'APPROVED', email: `${tag}-b@test.local` } as any });
    const prov = await prisma.user.create({ data: { passwordHash: 'x', role: 'TRANSPORTER', kycStatus: 'APPROVED', email: `${tag}-p@test.local` } as any });
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

  const quoted = async (price: number) => {
    const id = await newRequest();
    const q: any = await life.propose(id, providerId, 'PROVIDER', { price } as any);
    return { id, roundId: q.currentRound.id as string };
  };

  it('runs the full lifecycle: quote, accept, drive, deliver, acknowledge', async () => {
    const { id, roundId } = await quoted(45000);
    await life.accept(id, buyerId, { roundId });
    let row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('BOOKED');
    expect(Number(row?.agreedPrice)).toBe(45000);
    expect(row?.requestNumber).toMatch(/^TRQ-\d{4}-\d{6}$/);

    await expect(life.updateTracking(id, providerId, { status: 'PICKED_UP' } as any)).rejects.toThrow(/driver/i);
    await life.updateTracking(id, providerId, { status: 'PICKED_UP', driverName: 'Ali Khan', driverPhone: '+923001234567', vehicleRegNo: 'LEA-1234' } as any);
    await life.updateTracking(id, providerId, { status: 'IN_TRANSIT' } as any);
    await life.updateTracking(id, providerId, { status: 'DELIVERED' } as any);
    await life.acknowledge(id, buyerId, 'all good');
    row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('COMPLETED');
    expect(row?.acknowledgedAt).toBeTruthy();
  });

  it('two simultaneous accepts book it exactly once', async () => {
    const { id, roundId } = await quoted(30000);
    const results = await Promise.allSettled([life.accept(id, buyerId, { roundId }), life.accept(id, buyerId, { roundId })]);
    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('BOOKED');
    expect(await prisma.transportQuoteRound.count({ where: { requestId: id, status: 'ACCEPTED' as any } })).toBe(1);
  });

  it('after acceptance a re-quote is refused and the DB trigger protects the agreed price', async () => {
    const { id, roundId } = await quoted(10000);
    await life.accept(id, buyerId, { roundId });
    await expect(life.propose(id, providerId, 'PROVIDER', { price: 99999 } as any)).rejects.toThrow();
    await expect(prisma.transportRequest.update({ where: { id }, data: { agreedPrice: 1 } })).rejects.toThrow(/immutable/);
    const row = await prisma.transportRequest.findUnique({ where: { id } });
    expect(Number(row?.agreedPrice)).toBe(10000);
  });

  it('the database allows only one CURRENT round per request', async () => {
    const { id } = await quoted(5000);
    await expect(prisma.transportQuoteRound.create({
   data: {
  requestId: id,
  providerId,
  roundNo: 99,
  proposerId: providerId,
  proposerRole: 'PROVIDER',
  price: 1,
  totalPrice: 1,
  status: 'CURRENT' as any,
},
    })).rejects.toThrow();
  });
});
