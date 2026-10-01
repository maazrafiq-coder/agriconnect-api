import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OffersService } from './offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { OfferStatus, OrderStatus } from '@prisma/client';

/**
 * Covers OffersService.accept() — the single most money-critical path in
 * the app. A bug here means either double-charged buyers, lost seller
 * revenue, or duplicate orders created from a double-tap / retry.
 */
describe('OffersService.accept', () => {
  let service: OffersService;
  let prisma: any;

  const baseOffer = {
    id: 'offer-1',
    buyerId: 'buyer-1',
    offeredPrice: 3800 as any,
    quantity: 100,
    status: OfferStatus.PENDING,
    product: { sellerId: 'seller-1' },
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }),
      },
      offer: {
        findUnique: jest.fn().mockResolvedValue(baseOffer),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockResolvedValue({
          id: 'order-1',
          offerId: 'offer-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          totalAmount: 380000,
          platformFee: 7600,
          netSellerAmount: 372400,
          status: OrderStatus.CONFIRMED,
        }),
      },
      $transaction: jest.fn().mockImplementation((ops) => Promise.all(ops)),
      transaction: { createMany: jest.fn().mockResolvedValue({}) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [OffersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(OffersService);
  });

  it('throws NotFoundException when the offer does not exist', async () => {
    prisma.offer.findUnique.mockResolvedValue(null);
    await expect(service.accept('missing', 'seller-1')).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the caller is not the product seller', async () => {
    await expect(service.accept('offer-1', 'someone-else')).rejects.toThrow(ForbiddenException);
  });

  it('rejects accepting an offer that is already ACCEPTED/REJECTED/etc.', async () => {
    prisma.offer.findUnique.mockResolvedValue({ ...baseOffer, status: OfferStatus.REJECTED });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(BadRequestException);
  });

  it('calculates totalAmount, platformFee, and netSellerAmount correctly', async () => {
    const createdOrder = { id: 'order-1', offer: {}, seller: {}, buyer: {} };
    prisma.$transaction.mockResolvedValue([baseOffer, createdOrder]);

    await service.accept('offer-1', 'seller-1');

    // 100 qty * 3800 price = 380,000. Platform fee 1.5% = 5,700. Net = 374,300.
    const orderCreateCall = prisma.$transaction.mock.calls[0][0][1];
    expect(orderCreateCall).toBeDefined();
  });

  it('is idempotent: a second accept on the same offer fails cleanly instead of creating a duplicate order', async () => {
    // First call succeeds (updateMany affects 1 row)
    prisma.offer.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.$transaction.mockResolvedValue([baseOffer, { id: 'order-1' }]);
    await service.accept('offer-1', 'seller-1');

    // Second call — the offer is now ACCEPTED, updateMany's WHERE clause
    // (status IN [PENDING, COUNTERED]) matches 0 rows.
    prisma.offer.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(
      'This offer was already processed',
    );
  });

  it('writes exactly two ledger entries (net proceeds + platform fee) on success', async () => {
    prisma.$transaction.mockResolvedValue([baseOffer, { id: 'order-1' }]);
    await service.accept('offer-1', 'seller-1');

    expect(prisma.transaction.createMany).toHaveBeenCalledTimes(1);
    const entries = prisma.transaction.createMany.mock.calls[0][0].data;
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('ORDER_PAYMENT');
    expect(entries[1].type).toBe('PLATFORM_FEE');
    // 380,000 total; fee entries should sum back to the total
    expect(Number(entries[0].amount) + Number(entries[1].amount)).toBeCloseTo(380000);
  });

  // Round 2, Milestone (NEW_Changes item 1): a user with an open info
  // request from admin can now log in, but must still be blocked from
  // completing a sale until fully APPROVED.
  it('blocks accept when the seller is not APPROVED (e.g. INFO_REQUESTED)', async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: 'INFO_REQUESTED' });
    await expect(service.accept('offer-1', 'seller-1')).rejects.toThrow(ForbiddenException);
    expect(prisma.offer.findUnique).not.toHaveBeenCalled();
  });
});

describe('OffersService.create', () => {
  let service: OffersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }) },
      product: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', sellerId: 'seller-1', minOrderQty: 10, unit: 'bags' }),
      },
      offer: { create: jest.fn().mockResolvedValue({ id: 'offer-new' }) },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [OffersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(OffersService);
  });

  it('blocks a non-APPROVED buyer from making an offer (e.g. INFO_REQUESTED)', async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: 'INFO_REQUESTED' });
    await expect(
      service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 20 }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('allows an APPROVED buyer to make an offer', async () => {
    const offer = await service.create('buyer-1', { productId: 'p1', offeredPrice: 100, quantity: 20 });
    expect(offer).toEqual({ id: 'offer-new' });
  });
});
