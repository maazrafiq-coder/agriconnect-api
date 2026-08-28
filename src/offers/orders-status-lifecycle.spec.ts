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

  const baseOrder = {
    id: 'order-1',
    sellerId: 'seller-1',
    buyerId: 'buyer-1',
    status: OrderStatus.CONFIRMED,
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(baseOrder),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ ...baseOrder, ...data })),
      },
      orderStatusHistory: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation((ops) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [OrdersService, { provide: PrismaService, useValue: prisma }],
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
    prisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: OrderStatus.IN_TRANSIT });
    const result = await service.updateStatus('order-1', 'buyer-1', OrderStatus.DELIVERED);
    expect(result.status).toBe(OrderStatus.DELIVERED);

    await expect(
      service.updateStatus('order-1', 'seller-1', OrderStatus.DELIVERED),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets the buyer complete DELIVERED -> COMPLETED and stamps completedAt', async () => {
    prisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: OrderStatus.DELIVERED });
    const result = await service.updateStatus('order-1', 'buyer-1', OrderStatus.COMPLETED);
    expect(result.status).toBe(OrderStatus.COMPLETED);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.COMPLETED, completedAt: expect.any(Date) }),
      }),
    );
  });

  it('lets either party move CONFIRMED -> DISPUTED', async () => {
    const result = await service.updateStatus('order-1', 'seller-1', OrderStatus.DISPUTED);
    expect(result.status).toBe(OrderStatus.DISPUTED);
  });

  it('blocks ANY status change once an order is DISPUTED, even by the original parties', async () => {
    prisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: OrderStatus.DISPUTED });
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
    expect(prisma.order.update).toHaveBeenCalledWith(
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
    prisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: OrderStatus.COMPLETED });
    await expect(
      service.updateStatus('order-1', 'buyer-1', OrderStatus.CANCELLED),
    ).rejects.toThrow(BadRequestException);
  });
});
