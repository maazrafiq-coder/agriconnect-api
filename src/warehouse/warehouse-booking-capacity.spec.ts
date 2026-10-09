import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

/** Capacity check and booking insert must happen inside one locked transaction. */
describe('WarehouseService.bookStorage capacity', () => {
  let service: WarehouseService;
  let tx: any;
  let prisma: any;
  const dto: any = { warehouseId: 'w1', commodity: 'Rice', quantityTons: 60, durationDays: 30, entryDate: '2026-11-01' };

  beforeEach(async () => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      storageBooking: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { quantityTons: 50 } }),
        create: jest.fn().mockResolvedValue({ id: 'b1', warehouse: { name: 'WH', city: 'X', managerPhone: '1' } }),
      },
    };
    prisma = {
      warehouseProfile: { findUnique: jest.fn().mockResolvedValue({
        id: 'w1', userId: 'op', isActive: true, commoditiesAccepted: ['Rice'], minDurationDays: 1,
        totalCapacityTons: 100, pricePerTonMonth: 100, ratesByCommodity: null,
      }) },
      transaction: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        WarehouseService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: NotificationsService, useValue: { notify: jest.fn().mockResolvedValue(undefined) } },
        { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn().mockResolvedValue(38000), getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } },
      ],
    }).compile();
    service = moduleRef.get(WarehouseService);
  });

  it('rejects a request that exceeds remaining capacity, without inserting', async () => {
    await expect(service.bookStorage('u1', dto)).rejects.toThrow(BadRequestException);
    expect(tx.storageBooking.create).not.toHaveBeenCalled();
  });

  it('locks the warehouse row and inserts inside the transaction when it fits', async () => {
    await service.bookStorage('u1', { ...dto, quantityTons: 40 });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.storageBooking.create).toHaveBeenCalled();
  });
});
