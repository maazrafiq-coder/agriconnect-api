import { NotificationsService } from '../notifications/notifications.service';
import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus } from '@prisma/client';

/**
 * Round 2, Milestone 7 — order status state machine.
 *
 * Before this milestone, PATCH /orders/:id/status accepted any
 * OrderStatus from either party with no transition rules — a buyer or
 * seller could jump straight to COMPLETED, or move an order out of
 * DISPUTED before an admin ever resolved it. These tests cover the new
 * allow-list: legal transitions succeed for the right party, illegal
 * ones (wrong status, wrong party, or anything touching DISPUTED) are
 * rejected.
 */
describe('OrdersService — status lifecycle', () => {
  let service: OrdersService;
  let prisma: any;
  let applied: any = {};
  let stored: any;

  const baseOrder = {
    id: 'order-1',
    sellerId: 'seller-1',
    buyerId: 'buyer-1',
    status: OrderStatus.CONFIRMED,
    offer: { productId: 'prod-1', quantity: 40 },
    netSellerAmount: 98500, platformFee: 1500, platformFeePct: 1.5,
  };

  beforeEach(async () => {
    applied = {};
    stored = baseOrder;
    prisma = {
      order: {
        // First read (with include) = the order as stored; the read after the
        // update (no include) reflects whatever updateMany applied.
        findUnique: jest.fn().mockImplementation((args: any) =>
          Promise.resolve(args?.include ? stored : { ...stored, ...applied })),
        updateMany: jest.fn().mockImplementation(({ data }: any) => { applied = data; return Promise.resolve({ count: 1 }); }),
      },
      orderStatusHistory: {
        create: jest.fn().mockResolvedValue({}),
      },
      product: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      // Interactive transaction: run the callback against this same stub.
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [OrdersService, { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) } }],
    }).compile();

    service = moduleRef.get(OrdersService);
  });

  it('lets the seller move CONFIRMED -> IN_TRANSIT', async () => {
    const result = await service.updateStatus('order-1', 'seller-1', OrderStatus.IN_TRANSIT);
    expect(result.status).toBe(OrderStatus.IN_TRANSIT);
  });

  it('does NOT let the buyer move CONFIRMED -> IN_TRANSIT', async () => {
    await expect(
      service.updateStatus('order-1', 'buyer-1', OrderStatus.IN_TRANSIT),
    ).rejects.toThrow(ForbiddenException);
  });

  it('does NOT let either party jump CONFIRMED -> COMPLETED', async () => {
    await expect(
      service.updateStatus('order-1', 'buyer-1', OrderStatus.COMPLETED),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateStatus('order-1', 'seller-1', OrderStatus.COMPLETED),
    ).rejects.toThrow(BadRequestException);
  });

  it('lets the buyer confirm IN_TRANSIT -> DELIVERED, but not the seller', async () => {
    stored = { ...baseOrder, status: OrderStatus.IN_TRANSIT };
    const result = await service.updateStatus('order-1', 'buyer-1', OrderStatus.DELIVERED);
    expect(result.status).toBe(OrderStatus.DELIVERED);

    await expect(
      service.updateStatus('order-1', 'seller-1', OrderStatus.DELIVERED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets the buyer complete DELIVERED -> COMPLETED and stamps completedAt', async () => {
    stored = { ...baseOrder, status: OrderStatus.DELIVERED };
    const result = await service.updateStatus('order-1', 'buyer-1', OrderStatus.COMPLETED);
    expect(result.status).toBe(OrderStatus.COMPLETED);
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.COMPLETED, completedAt: expect.any(Date) }),
      }),
    );
  });

  it('lets either party move CONFIRMED -> DISPUTED', async () => {
    const result = await service.updateStatus('order-1', 'seller-1', OrderStatus.DISPUTED, 'Goods not as described');
    expect(result.status).toBe(OrderStatus.DISPUTED);
  });

  it('blocks ANY status change once an order is DISPUTED, even by the original parties', async () => {
    stored = { ...baseOrder, status: OrderStatus.DISPUTED };
    await expect(
      service.updateStatus('order-1', 'seller-1', OrderStatus.COMPLETED),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateStatus('order-1', 'buyer-1', OrderStatus.CANCELLED),
    ).rejects.toThrow(BadRequestException);
  });

  it('stamps cancelledAt/cancelReason on CANCELLED', async () => {
    const result = await service.updateStatus('order-1', 'buyer-1', OrderStatus.CANCELLED, 'Changed my mind');
    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OrderStatus.CANCELLED,
          cancelledAt: expect.any(Date),
          cancelReason: 'Changed my mind',
        }),
      }),
    );
  });

  it('rejects a caller who is neither the seller nor the buyer', async () => {
    await expect(
      service.updateStatus('order-1', 'someone-else', OrderStatus.CANCELLED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('404s on a nonexistent order', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(
      service.updateStatus('order-1', 'seller-1', OrderStatus.CANCELLED),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects transitions out of a terminal state (COMPLETED)', async () => {
    stored = { ...baseOrder, status: OrderStatus.COMPLETED };
    await expect(
      service.updateStatus('order-1', 'buyer-1', OrderStatus.CANCELLED),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Milestone 2 additions ──────────────────────────────────────────────
  it('requires a reason (>= 5 chars) to raise a dispute', async () => {
    await expect(service.updateStatus('order-1', 'buyer-1', OrderStatus.DISPUTED)).rejects.toThrow(/reason/);
    await expect(service.updateStatus('order-1', 'buyer-1', OrderStatus.DISPUTED, ' hi ')).rejects.toThrow(/reason/);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('requires a reason to cancel', async () => {
    await expect(service.updateStatus('order-1', 'seller-1', OrderStatus.CANCELLED)).rejects.toThrow(/reason/);
  });

  it('records the dispute reason in the order history', async () => {
    await service.updateStatus('order-1', 'buyer-1', OrderStatus.DISPUTED, '  Goods not as described ');
    expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', status: OrderStatus.DISPUTED, changedBy: 'buyer-1', note: 'Goods not as described' },
    });
  });

  it('cancelling puts the quantity back on the listing and re-opens a SOLD one', async () => {
    await service.updateStatus('order-1', 'buyer-1', OrderStatus.CANCELLED, 'Changed my mind');
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' }, data: { quantity: { increment: 40 } },
    });
    expect(prisma.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'prod-1', status: 'SOLD' }, data: { status: 'ACTIVE' },
    });
  });

  it('non-cancel transitions do not touch stock', async () => {
    await service.updateStatus('order-1', 'seller-1', OrderStatus.IN_TRANSIT);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('refuses to apply if the order changed under us (concurrent update)', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateStatus('order-1', 'seller-1', OrderStatus.IN_TRANSIT)).rejects.toThrow(/refresh/);
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  describe('ledger settlement', () => {
    it('books ORDER_PAYMENT (net) + PLATFORM_FEE when the buyer completes the order', async () => {
      stored = { ...baseOrder, status: OrderStatus.DELIVERED };
      await service.updateStatus('order-1', 'buyer-1', OrderStatus.COMPLETED);
      const rows = prisma.transaction.createMany.mock.calls[0][0].data;
      expect(rows.map((r: any) => [r.type, r.amount, r.userId])).toEqual([
        ['ORDER_PAYMENT', 98500, 'seller-1'],
        ['PLATFORM_FEE', 1500, 'seller-1'],
      ]);
    });

    it('is idempotent: no second settlement if one already exists', async () => {
      stored = { ...baseOrder, status: OrderStatus.DELIVERED };
      prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-1' });
      await service.updateStatus('order-1', 'buyer-1', OrderStatus.COMPLETED);
      expect(prisma.transaction.createMany).not.toHaveBeenCalled();
    });

    it('books nothing for cancelled, disputed or in-transit moves', async () => {
      await service.updateStatus('order-1', 'seller-1', OrderStatus.IN_TRANSIT);
      await service.updateStatus('order-1', 'buyer-1', OrderStatus.CANCELLED, 'changed my mind');
      await service.updateStatus('order-1', 'seller-1', OrderStatus.DISPUTED, 'Goods not as described');
      expect(prisma.transaction.createMany).not.toHaveBeenCalled();
    });

    it('admin resolving a dispute: completed books the sale, cancelled does not', async () => {
      stored = { ...baseOrder, status: OrderStatus.DISPUTED };
      prisma.order.update = jest.fn().mockResolvedValue({ id: 'order-1' });
      await service.adminResolveDispute('order-1', 'admin-1', 'cancelled', 'refund');
      expect(prisma.transaction.createMany).not.toHaveBeenCalled();
      await service.adminResolveDispute('order-1', 'admin-1', 'completed', 'ok');
      expect(prisma.transaction.createMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAdminSummary', () => {
    it('reports revenue from COMPLETED orders only and keeps in-progress separate', async () => {
      prisma.order.groupBy = jest.fn().mockResolvedValue([{ status: 'COMPLETED', _count: { _all: 2 } }, { status: 'CANCELLED', _count: { _all: 1 } }]);
      prisma.order.aggregate = jest.fn()
        .mockResolvedValueOnce({ _sum: { totalAmount: 500000, platformFee: 7500, netSellerAmount: 492500 } })
        .mockResolvedValueOnce({ _sum: { totalAmount: 200000, platformFee: 3000 } });
      const r = await service.getAdminSummary();
      expect(r.totalOrders).toBe(3);
      expect(r.completed).toEqual({ orderValue: 500000, platformRevenue: 7500, netToSellers: 492500 });
      expect(r.inProgress).toEqual({ orderValue: 200000, expectedPlatformFees: 3000 });
      expect(prisma.order.aggregate.mock.calls[0][0].where).toEqual({ status: 'COMPLETED' });
    });
  });

  it('admin resolving a dispute as cancelled restores stock; as completed does not', async () => {
    stored = { ...baseOrder, status: OrderStatus.DISPUTED };
    prisma.order.update = jest.fn().mockResolvedValue({ id: 'order-1' });
    await service.adminResolveDispute('order-1', 'admin-1', 'completed', 'ok');
    expect(prisma.product.update).not.toHaveBeenCalled();
    await service.adminResolveDispute('order-1', 'admin-1', 'cancelled', 'refund');
    expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: 'prod-1' }, data: { quantity: { increment: 40 } } });
  });
});
