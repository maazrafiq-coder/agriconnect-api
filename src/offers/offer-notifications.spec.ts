import { Test } from '@nestjs/testing';
import { OffersService, OrdersService } from './offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OfferStatus, OrderStatus, ProductStatus } from '@prisma/client';

const future = () => new Date(Date.now() + 3600_000);

describe('In-app notifications — offers & orders', () => {
  let offers: OffersService;
  let orders: OrdersService;
  let prisma: any;
  let notifications: { notify: jest.Mock; notifyMany: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ kycStatus: 'APPROVED' }) },
      product: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
      offer: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
      orderStatusHistory: { create: jest.fn() },
      transaction: { findFirst: jest.fn().mockResolvedValue(null), createMany: jest.fn() },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    };
    notifications = { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) };
    const ref = await Test.createTestingModule({
      providers: [
        OffersService, OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: { getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    offers = ref.get(OffersService);
    orders = ref.get(OrdersService);
  });

  it('a new offer notifies the SELLER (OFFER_RECEIVED)', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'p', name: 'Rice', unit: 'kg', sellerId: 'seller-1', status: ProductStatus.ACTIVE, minOrderQty: 1, quantity: 100 });
    prisma.offer.create.mockResolvedValue({ id: 'o1', buyer: { profile: { fullName: 'Ali' } } });
    await offers.create('buyer-1', { productId: 'p', offeredPrice: 100, quantity: 10 } as any);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'seller-1', type: 'OFFER_RECEIVED' }));
  });

  it('a counter notifies the BUYER', async () => {
    prisma.offer.findUnique.mockResolvedValue({ id: 'o1', buyerId: 'buyer-1', status: OfferStatus.PENDING, expiresAt: future(), product: { sellerId: 'seller-1', name: 'Rice' } });
    prisma.offer.update.mockResolvedValue({ id: 'o1' });
    await offers.counter('o1', 'seller-1', { counterPrice: 120 } as any);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'buyer-1', title: expect.stringMatching(/counter/i) }));
  });

  it('a decline notifies the BUYER (OFFER_REJECTED); a withdraw notifies the SELLER', async () => {
    prisma.offer.findUnique.mockResolvedValue({ id: 'o1', buyerId: 'buyer-1', status: OfferStatus.PENDING, product: { sellerId: 'seller-1', name: 'Rice' } });
    await offers.reject('o1', 'seller-1', 'too low');
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', type: 'OFFER_REJECTED' }));
    await offers.withdraw('o1', 'buyer-1');
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller-1' }));
  });

  it('seller accepting notifies the buyer; buyer accepting a counter notifies the seller', async () => {
    const offer = { id: 'o1', productId: 'p', buyerId: 'buyer-1', quantity: 10, status: OfferStatus.PENDING, offeredPrice: 100, expiresAt: future(), product: { sellerId: 'seller-1' } };
    prisma.offer.findUnique.mockResolvedValue(offer);
    prisma.product.updateMany.mockResolvedValue({ count: 1 });
    prisma.product.findUnique.mockResolvedValue({ quantity: 50 });
    prisma.order = { ...prisma.order, create: jest.fn().mockResolvedValue({ id: 'ord1' }) };
    await offers.accept('o1', 'seller-1');
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', type: 'OFFER_ACCEPTED' }));
    prisma.offer.findUnique.mockResolvedValue({ ...offer, status: OfferStatus.COUNTERED, counterPrice: 120 });
    await offers.acceptCounter('o1', 'buyer-1');
    expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller-1', type: 'OFFER_ACCEPTED' }));
  });

  it('an order status change notifies the OTHER party only', async () => {
    prisma.order.findUnique.mockImplementation((a: any) => Promise.resolve({
      id: 'order-12345678', sellerId: 'seller-1', buyerId: 'buyer-1', status: OrderStatus.CONFIRMED, offer: { productId: 'p', quantity: 1 },
    }));
    await orders.updateStatus('order-12345678', 'seller-1', OrderStatus.IN_TRANSIT);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'buyer-1', type: 'ORDER_UPDATE' }));
  });
});
