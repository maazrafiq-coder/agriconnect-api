import { Test } from '@nestjs/testing';
import { OffersService, OrdersService } from './offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus } from '@prisma/client';
import { makeFakePrisma } from './__testing__/fake-prisma';


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

  describe('negotiation (stateful)', () => {
    let db: any;
    beforeEach(async () => {
      db = makeFakePrisma();
      db.user.seed({ id: 'seller-1' }); db.user.seed({ id: 'buyer-1' });
      db.product.seed({ id: 'p', sellerId: 'seller-1', name: 'Rice', unit: 'kg', quantity: 100, minOrderQty: 1, paymentTerms: { type: 'COD' } });
      const ref = await Test.createTestingModule({
        providers: [
          OffersService,
          { provide: PrismaService, useValue: db },
          { provide: SettingsService, useValue: { getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } },
          { provide: NotificationsService, useValue: notifications },
        ],
      }).compile();
      offers = ref.get(OffersService);
    });
    const newOffer = () => offers.create('buyer-1', { productId: 'p', offeredPrice: 100, quantity: 10, acceptTerms: true } as any);

    it('a new offer notifies the SELLER (OFFER_RECEIVED) with the terms and a deep link', async () => {
      const o: any = await newOffer();
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'seller-1', type: 'OFFER_RECEIVED', body: expect.stringMatching(/Cash on delivery/),
        data: expect.objectContaining({ route: '/seller', tab: 'offers', entityType: 'offer', entityId: o.id }),
      }));
    });

    it('a counter notifies the OTHER party (seller counter -> buyer, buyer counter-back -> seller)', async () => {
      const o: any = await newOffer();
      await offers.counter(o.id, 'seller-1', { counterPrice: 120 } as any);
      expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', title: expect.stringMatching(/counter/i) }));
      await offers.propose(o.id, 'buyer-1', { price: 110 });
      expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller-1', title: expect.stringMatching(/counter/i) }));
    });

    it('a decline notifies the BUYER (OFFER_REJECTED); a withdraw notifies the SELLER', async () => {
      const o: any = await newOffer();
      await offers.reject(o.id, 'seller-1', 'too low');
      expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', type: 'OFFER_REJECTED' }));
      const o2: any = await newOffer();
      await offers.withdraw(o2.id, 'buyer-1');
      expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller-1' }));
    });

    it('seller accepting notifies the buyer; buyer accepting a counter notifies the seller', async () => {
      const o: any = await newOffer();
      await offers.accept(o.id, 'seller-1', { acceptTerms: true });
      expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', type: 'OFFER_ACCEPTED' }));
      const o2: any = await newOffer();
      await offers.counter(o2.id, 'seller-1', { counterPrice: 120 } as any);
      await offers.acceptCounter(o2.id, 'buyer-1', { acceptTerms: true });
      expect(notifications.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller-1', type: 'OFFER_ACCEPTED' }));
    });
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
