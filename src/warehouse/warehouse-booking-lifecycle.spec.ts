import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, ReceiptStatus, LienStatus } from '@prisma/client';

/**
 * Round 2, Milestone 2 — warehouse booking state machine.
 *
 * Covers the new REQUESTED → ACCEPTED/REJECTED/CANCELLED → ACTIVE →
 * COMPLETED lifecycle: legal transitions succeed, illegal ones are
 * rejected, ownership is enforced, and the booking reference is derived
 * correctly from bookingSeq + createdAt.
 */
describe('WarehouseService — booking lifecycle', () => {
  let service: WarehouseService;
  let prisma: any;

  const baseWarehouse = { id: 'wh-1', userId: 'operator-1', name: 'Test Warehouse', city: 'Lahore' };

  const baseBooking = {
    id: 'booking-1',
    bookingSeq: 42,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    warehouseId: 'wh-1',
    depositorId: 'buyer-1',
    status: BookingStatus.REQUESTED,
    warehouse: baseWarehouse,
    receipt: null,
  };

  beforeEach(async () => {
    prisma = {
      storageBooking: {
        findUnique: jest.fn().mockResolvedValue(baseBooking),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ ...baseBooking, ...data, warehouse: baseWarehouse })),
        findMany: jest.fn().mockResolvedValue([baseBooking]),
      },
      warehouseReceipt: {
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation((ops) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(WarehouseService);
  });

  describe('acceptBooking', () => {
    it('accepts a REQUESTED booking and stamps acceptedAt', async () => {
      const result = await service.acceptBooking('operator-1', 'booking-1');
      expect(result.status).toBe(BookingStatus.ACCEPTED);
      expect(prisma.storageBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: BookingStatus.ACCEPTED }) }),
      );
    });

    it('rejects with Forbidden if the caller does not own the warehouse', async () => {
      await expect(service.acceptBooking('someone-else', 'booking-1')).rejects.toThrow(ForbiddenException);
    });

    it('rejects with NotFound if the booking does not exist', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue(null);
      await expect(service.acceptBooking('operator-1', 'booking-1')).rejects.toThrow(NotFoundException);
    });

    it('refuses to accept a booking that is not REQUESTED (e.g. already ACCEPTED)', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...baseBooking, status: BookingStatus.ACCEPTED });
      await expect(service.acceptBooking('operator-1', 'booking-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses to accept a REJECTED booking', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...baseBooking, status: BookingStatus.REJECTED });
      await expect(service.acceptBooking('operator-1', 'booking-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('rejectBooking', () => {
    const dto = { reason: 'No capacity for this commodity right now' };

    it('rejects a REQUESTED booking with a reason', async () => {
      const result = await service.rejectBooking('operator-1', 'booking-1', dto);
      expect(result.status).toBe(BookingStatus.REJECTED);
      expect(prisma.storageBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: BookingStatus.REJECTED, rejectionReason: dto.reason }) }),
      );
    });

    it('cannot reject a booking that is already ACTIVE', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...baseBooking, status: BookingStatus.ACTIVE });
      await expect(service.rejectBooking('operator-1', 'booking-1', dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancelBooking', () => {
    it('lets the depositor cancel their own REQUESTED booking', async () => {
      const result = await service.cancelBooking('buyer-1', 'BUYER', 'booking-1', {});
      expect(result.status).toBe(BookingStatus.CANCELLED);
    });

    it('lets the operator cancel too', async () => {
      const result = await service.cancelBooking('operator-1', 'WAREHOUSE', 'booking-1', { reason: 'flooding' });
      expect(result.status).toBe(BookingStatus.CANCELLED);
    });

    it('refuses an unrelated user', async () => {
      await expect(service.cancelBooking('random-user', 'BUYER', 'booking-1', {})).rejects.toThrow(ForbiddenException);
    });

    it('cannot cancel a COMPLETED booking', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...baseBooking, status: BookingStatus.COMPLETED });
      await expect(service.cancelBooking('buyer-1', 'BUYER', 'booking-1', {})).rejects.toThrow(BadRequestException);
    });

    it('can cancel an ACCEPTED booking (before goods arrive)', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...baseBooking, status: BookingStatus.ACCEPTED });
      const result = await service.cancelBooking('buyer-1', 'BUYER', 'booking-1', {});
      expect(result.status).toBe(BookingStatus.CANCELLED);
    });
  });

  describe('completeBooking', () => {
    it('completes an ACTIVE booking with no receipt', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...baseBooking, status: BookingStatus.ACTIVE, receipt: null });
      const result = await service.completeBooking('operator-1', 'booking-1');
      expect(result.status).toBe(BookingStatus.COMPLETED);
    });

    it('releases an ACTIVE receipt when completing the booking', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.ACTIVE,
        receipt: { id: 'receipt-1', status: ReceiptStatus.ACTIVE, lien: null },
      });
      await service.completeBooking('operator-1', 'booking-1');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('refuses to complete while an active bank lien exists on the receipt', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.ACTIVE,
        receipt: { id: 'receipt-1', status: ReceiptStatus.UNDER_LIEN, lien: { status: LienStatus.ACTIVE } },
      });
      await expect(service.completeBooking('operator-1', 'booking-1')).rejects.toThrow(
        /active bank lien/,
      );
    });

    it('cannot complete a booking that is still REQUESTED', async () => {
      await expect(service.completeBooking('operator-1', 'booking-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('booking reference formatting', () => {
    it('derives WHB-<year>-<seq> from bookingSeq + createdAt', async () => {
      const result = await service.acceptBooking('operator-1', 'booking-1');
      expect(result.bookingReference).toBe('WHB-2026-000042');
    });

    it('is present on getMyBookings results', async () => {
      const result = await service.getMyBookings('buyer-1');
      expect(result[0].bookingReference).toBe('WHB-2026-000042');
    });
  });
});
