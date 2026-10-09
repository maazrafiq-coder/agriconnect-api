/**
 * Money paths of the trade loop against a REAL Postgres:
 * offer → accept → order, platform fee, counter acceptance (+ race),
 * competing offers, cancel → stock restored, complete → ledger.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   export TEST_DATABASE_URL=postgresql://test:test@localhost:5433/agri_test
 *   npm run test:integration:setup && npm run test:integration
 *
 * NOT executed in the authoring sandbox (no Postgres / Prisma engines) — the
 * first CI / local run is the first real run. See MIGRATION_NOTES_R3_M7.md.
 */
import { PrismaClient } from '@prisma/client';
import { buildServices, connect, describeDb, ledger, makeProduct, makeUser, sum } from './helpers/integration';

describeDb('Trade loop & ledger (real database)', () => {
  let prisma: PrismaClient;
  let svc: ReturnType<typeof buildServices>;
  let admin: any, seller: any, buyer: any;

  beforeAll(async () => {
    prisma = await connect();
    svc = buildServices(prisma);
    admin = await makeUser(prisma, 'ADMIN');
    seller = await makeUser(prisma, 'TRADER');
    buyer = await makeUser(prisma, 'BUYER');
    await svc.settings.setPlatformFeePct(1.5, admin.id);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  const offerOn = (productId: string, over: Record<string, any> = {}) =>
    svc.offers.create(buyer.id, { productId, offeredPrice: 90, quantity: 20, ...over } as any);

  it('accept: creates the order at the offered price, deducts stock, books nothing in the ledger yet', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 100 });
    const offer = await offerOn(p.id);
    const { order } = (await svc.offers.accept(offer.id, seller.id)) as any;

    expect(Number(order.totalAmount)).toBe(1800);
    expect(Number(order.platformFeePct)).toBe(1.5);
    expect(Number(order.platformFee)).toBe(27);
    expect(Number(order.netSellerAmount)).toBe(1773);
    expect(order.status).toBe('CONFIRMED');

    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.quantity).toBe(80);
    expect((await prisma.offer.findUnique({ where: { id: offer.id } }))?.status).toBe('ACCEPTED');
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(1);
    // Nothing is earned until the order completes.
    expect(await prisma.transaction.count({ where: { referenceId: order.id } })).toBe(0);
  });

  it('platform fee is the admin-set % at acceptance and is frozen on the order', async () => {
    const p = await makeProduct(prisma, seller.id);
    const first = (await svc.offers.accept((await offerOn(p.id, { quantity: 10, offeredPrice: 100 })).id, seller.id)) as any;
    await svc.settings.setPlatformFeePct(5, admin.id);
    const second = (await svc.offers.accept((await offerOn(p.id, { quantity: 10, offeredPrice: 100 })).id, seller.id)) as any;
    await svc.settings.setPlatformFeePct(1.5, admin.id);

    expect(Number(first.order.platformFee)).toBe(15);   // 1.5% of 1000
    expect(Number(second.order.platformFee)).toBe(50);  // 5% of 1000
    const reloaded = await prisma.order.findUnique({ where: { id: first.order.id } });
    expect(Number(reloaded?.platformFeePct)).toBe(1.5); // unchanged by the later fee change
  });

  it('counter: the order is created at the COUNTER price, and only the buyer can accept it', async () => {
    const p = await makeProduct(prisma, seller.id);
    const offer = await offerOn(p.id, { offeredPrice: 80, quantity: 10 });
    await svc.offers.counter(offer.id, seller.id, { counterPrice: 95 } as any);

    await expect(svc.offers.accept(offer.id, seller.id)).rejects.toThrow(/countered|waiting/i);
    const { order } = (await svc.offers.acceptCounter(offer.id, buyer.id)) as any;
    expect(Number(order.totalAmount)).toBe(950);
  });

  it('counter acceptance race: two simultaneous accepts create exactly one order and deduct stock once', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 100 });
    const offer = await offerOn(p.id, { offeredPrice: 80, quantity: 30 });
    await svc.offers.counter(offer.id, seller.id, { counterPrice: 90 } as any);

    const results = await Promise.allSettled([
      svc.offers.acceptCounter(offer.id, buyer.id),
      svc.offers.acceptCounter(offer.id, buyer.id),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.order.count({ where: { offerId: offer.id } })).toBe(1);
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.quantity).toBe(70);
  });

  it('seller accept race: double-click creates one order', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 100 });
    const offer = await offerOn(p.id, { quantity: 10 });
    const results = await Promise.allSettled([svc.offers.accept(offer.id, seller.id), svc.offers.accept(offer.id, seller.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.order.count({ where: { offerId: offer.id } })).toBe(1);
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.quantity).toBe(90);
  });

  it('two offers for the last stock: only one order; the loser is closed with a reason', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 50 });
    const a = await offerOn(p.id, { quantity: 50 });
    const b = await offerOn(p.id, { quantity: 50 });
    const results = await Promise.allSettled([svc.offers.accept(a.id, seller.id), svc.offers.accept(b.id, seller.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const prod = await prisma.product.findUnique({ where: { id: p.id } });
    expect(prod?.quantity).toBe(0);
    expect(prod?.status).toBe('SOLD');
    expect(await prisma.order.count({ where: { offer: { productId: p.id } } })).toBe(1);
  });

  it('accepting closes only the competing offers that can no longer be fulfilled', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 100 });
    const big = await offerOn(p.id, { quantity: 60 });
    const small = await offerOn(p.id, { quantity: 10 });
    const winner = await offerOn(p.id, { quantity: 70 });
    await svc.offers.accept(winner.id, seller.id); // 30 left
    expect((await prisma.offer.findUnique({ where: { id: big.id } }))?.status).toBe('REJECTED');
    expect((await prisma.offer.findUnique({ where: { id: small.id } }))?.status).toBe('PENDING');
  });

  it('cancelling puts the stock back and re-opens a SOLD listing; no ledger rows exist', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 40 });
    const { order } = (await svc.offers.accept((await offerOn(p.id, { quantity: 40 })).id, seller.id)) as any;
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.status).toBe('SOLD');

    await svc.orders.updateStatus(order.id, seller.id, 'CANCELLED' as any, 'Out of stock after all');
    const prod = await prisma.product.findUnique({ where: { id: p.id } });
    expect(prod?.quantity).toBe(40);
    expect(prod?.status).toBe('ACTIVE');
    expect(await prisma.transaction.count({ where: { referenceId: order.id } })).toBe(0);
  });

  it('completing books net proceeds + platform fee exactly once; the totals add up to the order', async () => {
    const p = await makeProduct(prisma, seller.id);
    const { order } = (await svc.offers.accept((await offerOn(p.id, { quantity: 20, offeredPrice: 100 })).id, seller.id)) as any;

    await svc.orders.updateStatus(order.id, seller.id, 'IN_TRANSIT' as any);
    await svc.orders.updateStatus(order.id, buyer.id, 'DELIVERED' as any);
    await svc.orders.updateStatus(order.id, buyer.id, 'COMPLETED' as any);

    const rows = await prisma.transaction.findMany({ where: { referenceId: order.id } });
    expect(rows).toHaveLength(2);
    const net = rows.find((r: any) => r.type === 'ORDER_PAYMENT');
    const fee = rows.find((r: any) => r.type === 'PLATFORM_FEE');
    expect(Number(net?.amount)).toBe(1970);
    expect(Number(fee?.amount)).toBe(30);
    expect(Number(net?.amount) + Number(fee?.amount)).toBe(Number(order.totalAmount));

    // A second COMPLETED is refused and cannot book again.
    await expect(svc.orders.updateStatus(order.id, buyer.id, 'COMPLETED' as any)).rejects.toThrow();
    expect(await prisma.transaction.count({ where: { referenceId: order.id } })).toBe(2);
  });

  it('a disputed order resolved as completed books the sale once; resolved as cancelled restores stock and books nothing', async () => {
    const p = await makeProduct(prisma, seller.id, { quantity: 100 });
    const done = (await svc.offers.accept((await offerOn(p.id, { quantity: 10 })).id, seller.id)) as any;
    await svc.orders.updateStatus(done.order.id, buyer.id, 'DISPUTED' as any, 'Goods not as described');
    await svc.orders.adminResolveDispute(done.order.id, admin.id, 'completed', 'Seller was right');
    expect(await prisma.transaction.count({ where: { referenceId: done.order.id } })).toBe(2);

    const cancelled = (await svc.offers.accept((await offerOn(p.id, { quantity: 10 })).id, seller.id)) as any;
    await svc.orders.updateStatus(cancelled.order.id, buyer.id, 'DISPUTED' as any, 'Never arrived');
    const before = (await prisma.product.findUnique({ where: { id: p.id } }))?.quantity;
    await svc.orders.adminResolveDispute(cancelled.order.id, admin.id, 'cancelled', 'Refund the buyer');
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.quantity).toBe((before ?? 0) + 10);
    expect(await prisma.transaction.count({ where: { referenceId: cancelled.order.id } })).toBe(0);
  });

  it('seller ledger equals the sum of its completed orders', async () => {
    const s = await makeUser(prisma, 'TRADER');
    const p = await makeProduct(prisma, s.id, { quantity: 1000 });
    let expectedNet = 0, expectedFee = 0;
    for (const qty of [10, 25, 40]) {
      const { order } = (await svc.offers.accept((await svc.offers.create(buyer.id, { productId: p.id, offeredPrice: 100, quantity: qty } as any)).id, s.id)) as any;
      await svc.orders.updateStatus(order.id, s.id, 'IN_TRANSIT' as any);
      await svc.orders.updateStatus(order.id, buyer.id, 'DELIVERED' as any);
      await svc.orders.updateStatus(order.id, buyer.id, 'COMPLETED' as any);
      expectedNet += Number(order.netSellerAmount);
      expectedFee += Number(order.platformFee);
    }
    expect(sum(await ledger(prisma, s.id, 'ORDER_PAYMENT'))).toBeCloseTo(expectedNet, 2);
    expect(sum(await ledger(prisma, s.id, 'PLATFORM_FEE'))).toBeCloseTo(expectedFee, 2);
  });
});
