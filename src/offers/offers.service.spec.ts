import { NotificationsService } from '../notifications/notifications.service';
import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OffersService } from './offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { OfferStatus, OrderStatus } from '@prisma/client';

/**
 * The single most money-critical path in the app: turning an offer into an
 * order. Milestone 2 rewrote it so that acceptance (seller on the original
 * offer, buyer on a counter) happens in ONE transaction that also deducts
 * stock and closes competing offers.
 */
function makePrisma() {
  const p: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }) },
    offer: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'offer-new' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    product: {
      findUnique: jest.fn().mockResolvedValue({ quantity: 400 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    order: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'order-1', ...data })),
    },
    transaction: { createMany: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(p)),
  };
  return p;
}

async function build(prisma: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [OffersService, { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) } }, { provide: SettingsService, useValue: { getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } }],
  }).compile();
  return moduleRef.get(OffersService);
}

const future = () => new Date(Date.now() + 3600_000);
const past = () => new Date(Date.now() - 3600_000);

describe('OffersService.accept (seller, original offer)', () => {
  let service: OffersService;
  let prisma: any;

  const baseOffer = {
    id: 'offer-1', productId: 'prod-1', buyerId: 'buyer-1',
    offeredPrice: 3800 as any, counterPrice: null, quantity: 100,
    status: OfferStatus.PENDING, expiresAt: future(),
    product: { sellerId: 'seller-1' },
  };

  beforeEach(async () => {
    prisma = makePrisma();
    prisma.offer.findUnique.mockResolvedValue(baseOffer);
    service = await build(prisma);
  });

  it('404s when the offer does not exist', async () => {
    prisma.offer.findUnique.mockResolvedValue(null);
    await expect(service.accept('x', 'seller-1')).rejects.toThrow(NotFoundException);
  });

  it('403s when the caller is not the product seller', async () => {
    await expect(service.accept('offer-1', 'someone-else')).rejects.toThrow(ForbiddenException);
  });

  it('blocks a non-APPROVED seller', async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: 'INFO_REQUESTED' });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(ForbiddenException);
    expect(prisma.offer.findUnique).not.toHaveBeenCalled();
  });

  it.each([OfferStatus.ACCEPTED, OfferStatus.REJECTED, OfferStatus.EXPIRED, OfferStatus.WITHDRAWN])(
    'refuses an offer in %s status', async (status) => {
      prisma.offer.findUnique.mockResolvedValue({ ...baseOffer, status });
      await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(BadRequestException);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

  it('the seller can NOT accept a COUNTERED offer (it would use the wrong price)', async () => {
    prisma.offer.findUnique.mockResolvedValue({ ...baseOffer, status: OfferStatus.COUNTERED, counterPrice: 4200 });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(/waiting for the buyer/);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('refuses and marks EXPIRED an offer past its deadline', async () => {
    prisma.offer.findUnique.mockResolvedValue({ ...baseOffer, expiresAt: past() });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow('This offer has expired');
    expect(prisma.offer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: OfferStatus.EXPIRED } }));
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('creates the order at the offered price with the right totals', async () => {
    const res = await service.accept('offer-1', 'seller-1');
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data.totalAmount).toBe(380000);        // 100 x 3800
    expect(data.platformFee).toBe(5700);          // 1.5%
    expect(data.netSellerAmount).toBe(374300);
    expect(data.status).toBe(OrderStatus.CONFIRMED);
    expect(res.order.id).toBe('order-1');
  });

  it('runs inside a single transaction', async () => {
    await service.accept('offer-1', 'seller-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a racing second accept fails and creates nothing', async () => {
    prisma.offer.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow('This offer was already processed');
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('deducts the quantity from the listing with a stock guard', async () => {
    await service.accept('offer-1', 'seller-1');
    expect(prisma.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'prod-1', status: { in: ['ACTIVE', 'UNDER_OFFER'] }, quantity: { gte: 100 } },
      data: { quantity: { decrement: 100 } },
    });
  });

  it('fails (and so rolls back) when there is not enough stock', async () => {
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(/no longer available/);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('marks the listing SOLD when stock reaches zero and closes ALL other open offers', async () => {
    prisma.product.findUnique.mockResolvedValue({ quantity: 0 });
    await service.accept('offer-1', 'seller-1');
    expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: 'prod-1' }, data: { status: 'SOLD' } });
    const close = prisma.offer.updateMany.mock.calls.find((c: any) => c[0].data.status === OfferStatus.REJECTED)[0];
    expect(close.where).toMatchObject({ productId: 'prod-1', id: { not: 'offer-1' }, quantity: { gt: 0 } });
    expect(close.data.rejectionReason).toMatch(/sold/i);
  });

  it('keeps the listing live and only closes offers that no longer fit when stock remains', async () => {
    prisma.product.findUnique.mockResolvedValue({ quantity: 150 });
    await service.accept('offer-1', 'seller-1');
    expect(prisma.product.update).not.toHaveBeenCalled();
    const close = prisma.offer.updateMany.mock.calls.find((c: any) => c[0].data.status === OfferStatus.REJECTED)[0];
    expect(close.where.quantity).toEqual({ gt: 150 });
  });

  it('books NOTHING in the ledger at acceptance (no money has moved yet)', async () => {
    await service.accept('offer-1', 'seller-1');
    expect(prisma.transaction.createMany).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('snapshots the admin-configured platform fee on the order', async () => {
    await service.accept('offer-1', 'seller-1');
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(Number(data.platformFeePct)).toBe(1.5);
    expect(Number(data.platformFee) + Number(data.netSellerAmount)).toBeCloseTo(380000);
  });
});

describe('OffersService.acceptCounter (buyer)', () => {
  let service: OffersService;
  let prisma: any;

  const countered = {
    id: 'offer-1', productId: 'prod-1', buyerId: 'buyer-1',
    offeredPrice: 3800 as any, counterPrice: 4200 as any, quantity: 100,
    status: OfferStatus.COUNTERED, expiresAt: future(),
    product: { sellerId: 'seller-1' },
  };

  beforeEach(async () => {
    prisma = makePrisma();
    prisma.offer.findUnique.mockResolvedValue(countered);
    service = await build(prisma);
  });

  it('creates the order at the COUNTER price, not the original offer', async () => {
    await service.acceptCounter('offer-1', 'buyer-1');
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data.totalAmount).toBe(420000);        // 100 x 4200
    expect(data.sellerId).toBe('seller-1');
    expect(data.buyerId).toBe('buyer-1');
    expect(data.statusHistory.create.changedBy).toBe('buyer-1');
  });

  it('only the buyer who made the offer can accept the counter', async () => {
    await expect(service.acceptCounter('offer-1', 'seller-1')).rejects.toThrow(ForbiddenException);
    await expect(service.acceptCounter('offer-1', 'stranger')).rejects.toThrow(ForbiddenException);
  });

  it('needs a counter to exist', async () => {
    prisma.offer.findUnique.mockResolvedValue({ ...countered, status: OfferStatus.PENDING, counterPrice: null });
    await expect(service.acceptCounter('offer-1', 'buyer-1')).rejects.toThrow(/no counter-offer/);
  });

  it('refuses an expired counter', async () => {
    prisma.offer.findUnique.mockResolvedValue({ ...countered, expiresAt: past() });
    await expect(service.acceptCounter('offer-1', 'buyer-1')).rejects.toThrow('This offer has expired');
  });

  it('blocks a non-APPROVED buyer', async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: 'SUBMITTED' });
    await expect(service.acceptCounter('offer-1', 'buyer-1')).rejects.toThrow(ForbiddenException);
  });

  it('is idempotent under a double-tap', async () => {
    prisma.offer.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.acceptCounter('offer-1', 'buyer-1')).rejects.toThrow('This offer was already processed');
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});

describe('OffersService.reject / withdraw / counter', () => {
  let service: OffersService;
  let prisma: any;
  const offer = (over: any = {}) => ({
    id: 'offer-1', productId: 'prod-1', buyerId: 'buyer-1', status: OfferStatus.PENDING,
    expiresAt: future(), product: { sellerId: 'seller-1' }, ...over,
  });

  beforeEach(async () => {
    prisma = makePrisma();
    prisma.offer.findUnique.mockResolvedValue(offer());
    service = await build(prisma);
  });

  it('seller can reject a PENDING or COUNTERED offer', async () => {
    await service.reject('offer-1', 'seller-1', 'too low');
    expect(prisma.offer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: OfferStatus.REJECTED, rejectionReason: 'too low' },
    }));
    prisma.offer.findUnique.mockResolvedValue(offer({ status: OfferStatus.COUNTERED }));
    await expect(service.reject('offer-1', 'seller-1')).resolves.toBeDefined();
  });

  it('cannot reject an ACCEPTED offer (an order already exists)', async () => {
    prisma.offer.findUnique.mockResolvedValue(offer({ status: OfferStatus.ACCEPTED }));
    await expect(service.reject('offer-1', 'seller-1')).rejects.toThrow(BadRequestException);
    expect(prisma.offer.updateMany).not.toHaveBeenCalled();
  });

  it('reject loses cleanly to a concurrent accept', async () => {
    prisma.offer.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.reject('offer-1', 'seller-1')).rejects.toThrow('already processed');
  });

  it('only the owning seller can reject', async () => {
    await expect(service.reject('offer-1', 'other')).rejects.toThrow(ForbiddenException);
  });

  it('buyer can withdraw an open offer or decline a counter, nobody else can', async () => {
    await service.withdraw('offer-1', 'buyer-1');
    expect(prisma.offer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: OfferStatus.WITHDRAWN } }));
    await expect(service.withdraw('offer-1', 'seller-1')).rejects.toThrow(ForbiddenException);
  });

  it('buyer cannot withdraw an accepted offer', async () => {
    prisma.offer.findUnique.mockResolvedValue(offer({ status: OfferStatus.ACCEPTED }));
    await expect(service.withdraw('offer-1', 'buyer-1')).rejects.toThrow(BadRequestException);
  });

  it('counter sets the counter price and gives the buyer a fresh deadline', async () => {
    await service.counter('offer-1', 'seller-1', { counterPrice: 4200 });
    const arg = prisma.offer.update.mock.calls[0][0];
    expect(arg.data.status).toBe(OfferStatus.COUNTERED);
    expect(arg.data.counterPrice).toBe(4200);
    expect(arg.data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
  });

  it('cannot counter an expired or non-pending offer', async () => {
    prisma.offer.findUnique.mockResolvedValue(offer({ expiresAt: past() }));
    await expect(service.counter('offer-1', 'seller-1', { counterPrice: 1 })).rejects.toThrow('expired');
    prisma.offer.findUnique.mockResolvedValue(offer({ status: OfferStatus.COUNTERED }));
    await expect(service.counter('offer-1', 'seller-1', { counterPrice: 1 })).rejects.toThrow(BadRequestException);
  });

  it('list queries sweep expired open offers first', async () => {
    await service.getBuyerOffers('buyer-1');
    expect(prisma.offer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ buyerId: 'buyer-1', expiresAt: { lt: expect.any(Date) } }),
      data: { status: OfferStatus.EXPIRED },
    }));
    prisma.offer.updateMany.mockClear();
    await service.getSellerOffers('seller-1');
    expect(prisma.offer.updateMany.mock.calls[0][0].where.product).toEqual({ sellerId: 'seller-1' });
  });
});

describe('OffersService.create', () => {
  let service: OffersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = makePrisma();
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1', sellerId: 'seller-1', minOrderQty: 10, unit: 'bags', quantity: 500, status: 'ACTIVE',
    });
    service = await build(prisma);
  });

  it('blocks a non-APPROVED buyer', async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: 'INFO_REQUESTED' });
    await expect(service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 20 })).rejects.toThrow(ForbiddenException);
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('allows an APPROVED buyer on a live listing', async () => {
    await expect(service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 20 })).resolves.toEqual({ id: 'offer-new' });
  });

  it.each(['PENDING_REVIEW', 'PAUSED', 'SOLD', 'REMOVED', 'REJECTED', 'DRAFT'])('rejects offers on a %s listing', async (status) => {
    prisma.product.findUnique.mockResolvedValue({ id: 'p1', sellerId: 'seller-1', minOrderQty: 1, unit: 'bags', quantity: 500, status });
    await expect(service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 20 })).rejects.toThrow(/not available/);
  });

  it('rejects more than the available stock', async () => {
    await expect(service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 501 })).rejects.toThrow(/Only 500/);
  });

  it('rejects below the minimum order and own-product offers', async () => {
    await expect(service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 5 })).rejects.toThrow(/Minimum order/);
    await expect(service.create('seller-1', { productId: 'p1', offeredPrice: 100, quantity: 20 })).rejects.toThrow(/own product/);
  });
});
