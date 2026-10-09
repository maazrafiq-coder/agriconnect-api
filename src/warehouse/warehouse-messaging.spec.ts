import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { BookingStatus } from '@prisma/client';

// Notifications are best-effort side effects; most tests only care that they
// don't break the action. Specific tests assert on `notificationsStub.notify*`.
const notificationsStub = { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) };

/** Booking conversation thread + insurance-rate validation (Oct 2026 issue list). */
describe('WarehouseService — booking messages & insurance validation', () => {
  let service: WarehouseService;
  let prisma: any;

  const booking = (status: BookingStatus = BookingStatus.REQUESTED) => ({
    id: 'b1', depositorId: 'buyer-1', status, warehouse: { userId: 'op-1' },
  });

  beforeEach(async () => {
    prisma = {
      storageBooking: { findUnique: jest.fn().mockResolvedValue(booking()) },
      bookingMessage: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm1', ...data })),
        findMany: jest.fn().mockResolvedValue([
          { id: 'm1', kind: 'INFO_REQUEST', body: 'Which variety?', createdAt: new Date(), senderId: 'op-1',
            sender: { id: 'op-1', profile: { fullName: 'Op', businessName: 'Cold Hub' } } },
        ]),
      },
      warehouseProfile: {
        create: jest.fn().mockResolvedValue({ id: 'wh-1' }),
        update: jest.fn().mockResolvedValue({ id: 'wh-1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'wh-1', userId: 'op-1', insuranceAvailable: false, insurancePricePerTonMonth: null }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: {} }, { provide: NotificationsService, useValue: notificationsStub }, { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn().mockResolvedValue(38000), getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } }],
    }).compile();
    service = moduleRef.get(WarehouseService);
  });

  it('lets the operator flag a message as an info request', async () => {
    await service.postBookingMessage('b1', 'op-1', 'WAREHOUSE', { body: ' Which variety? ', kind: 'INFO_REQUEST' });
    expect(prisma.bookingMessage.create).toHaveBeenCalledWith({
      data: { bookingId: 'b1', senderId: 'op-1', kind: 'INFO_REQUEST', body: 'Which variety?' },
    });
  });

  it('notifies the depositor of an info request, and the operator of a depositor reply', async () => {
    notificationsStub.notify.mockClear();
    prisma.storageBooking.findUnique.mockResolvedValue({ ...booking(), bookingSeq: 5, createdAt: new Date('2026-03-01'), warehouse: { userId: 'op-1', name: 'WH' } });
    await service.postBookingMessage('b1', 'op-1', 'WAREHOUSE', { body: 'Which variety?', kind: 'INFO_REQUEST' });
    expect(notificationsStub.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', title: 'Warehouse needs more information' }));
    await service.postBookingMessage('b1', 'buyer-1', 'BUYER', { body: '1121 Basmati' });
    expect(notificationsStub.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'op-1' }));
  });

  it('downgrades a depositor-sent INFO_REQUEST to a normal message', async () => {
    await service.postBookingMessage('b1', 'buyer-1', 'BUYER', { body: 'hello', kind: 'INFO_REQUEST' });
    expect(prisma.bookingMessage.create.mock.calls[0][0].data.kind).toBe('MESSAGE');
  });

  it('rejects outsiders and admins posting, but lets admins read', async () => {
    await expect(service.postBookingMessage('b1', 'stranger', 'BUYER', { body: 'x' })).rejects.toThrow(ForbiddenException);
    await expect(service.postBookingMessage('b1', 'admin-1', 'ADMIN', { body: 'x' })).rejects.toThrow(ForbiddenException);
    await expect(service.getBookingMessages('b1', 'admin-1', 'ADMIN')).resolves.toHaveLength(1);
    await expect(service.getBookingMessages('b1', 'stranger', 'BUYER')).rejects.toThrow(ForbiddenException);
  });

  it('closes the thread once a booking is rejected or cancelled', async () => {
    prisma.storageBooking.findUnique.mockResolvedValue(booking(BookingStatus.CANCELLED));
    await expect(service.postBookingMessage('b1', 'buyer-1', 'BUYER', { body: 'hi' })).rejects.toThrow(BadRequestException);
  });

  it('marks messages as mine for the viewer', async () => {
    const [m] = await service.getBookingMessages('b1', 'op-1', 'WAREHOUSE');
    expect(m.mine).toBe(true);
    expect(m.senderName).toBe('Cold Hub');
  });

  it('refuses to register a warehouse that offers insurance with no rate', async () => {
    await expect(service.create('op-1', { insuranceAvailable: true } as any)).rejects.toThrow(BadRequestException);
    await service.create('op-1', { insuranceAvailable: true, insurancePricePerTonMonth: 5 } as any);
    expect(prisma.warehouseProfile.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an edit that turns insurance on without a rate, and allows it with one', async () => {
    await expect(service.update('op-1', 'wh-1', { insuranceAvailable: true } as any)).rejects.toThrow(BadRequestException);
    await service.update('op-1', 'wh-1', { insuranceAvailable: true, insurancePricePerTonMonth: 4 } as any);
    expect(prisma.warehouseProfile.update).toHaveBeenCalledTimes(1);
  });
});
