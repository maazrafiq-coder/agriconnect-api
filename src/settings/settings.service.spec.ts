import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SettingsService, DEFAULT_PLATFORM_FEE_PCT } from './settings.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      commodityPrice: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({ commodity: 'rice' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      warehouseReceipt: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    };
    const ref = await Test.createTestingModule({
      providers: [SettingsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = ref.get(SettingsService);
  });

  describe('platform fee', () => {
    it('defaults to 1.5% when nothing is configured', async () => {
      expect(await service.getPlatformFeePct()).toBe(DEFAULT_PLATFORM_FEE_PCT);
    });

    it('returns the stored value, and falls back if the stored value is garbage', async () => {
      prisma.platformSetting.findUnique.mockResolvedValue({ value: '2.25' });
      expect(await service.getPlatformFeePct()).toBe(2.25);
      prisma.platformSetting.findUnique.mockResolvedValue({ value: 'abc' });
      expect(await service.getPlatformFeePct()).toBe(DEFAULT_PLATFORM_FEE_PCT);
    });

    it('saves a valid fee with the admin id, rejects out-of-range values', async () => {
      await service.setPlatformFeePct(2, 'admin-1');
      expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: { value: '2', updatedById: 'admin-1' },
      }));
      for (const bad of [-1, 25.5, NaN, Infinity]) {
        await expect(service.setPlatformFeePct(bad, 'admin-1')).rejects.toThrow(BadRequestException);
      }
    });
  });

  describe('commodity prices', () => {
    it('looks prices up case-insensitively; null when unset', async () => {
      expect(await service.getCommodityPricePerTon('  RICE ')).toBeNull();
      expect(prisma.commodityPrice.findUnique).toHaveBeenCalledWith({ where: { commodity: 'rice' } });
      prisma.commodityPrice.findUnique.mockResolvedValue({ pricePerTon: '152000' });
      expect(await service.getCommodityPricePerTon('rice')).toBe(152000);
    });

    it('validates input', async () => {
      await expect(service.setCommodityPrice('   ', 100, 'a')).rejects.toThrow(/name is required/);
      await expect(service.setCommodityPrice('Rice', 0, 'a')).rejects.toThrow(/greater than zero/);
      await expect(service.setCommodityPrice('Rice', -5, 'a')).rejects.toThrow(BadRequestException);
    });

    it('upserts a normalised key but keeps the display label', async () => {
      await service.setCommodityPrice(' Basmati Rice ', 160000, 'admin-1');
      expect(prisma.commodityPrice.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { commodity: 'basmati rice' },
        create: expect.objectContaining({ commodity: 'basmati rice', label: 'Basmati Rice', pricePerTon: 160000, updatedById: 'admin-1' }),
      }));
    });

    it('values receipts that were waiting on a price (marketValue 0)', async () => {
      prisma.warehouseReceipt.findMany.mockResolvedValue([{ id: 'r1', quantityTons: 10 }, { id: 'r2', quantityTons: 2.5 }]);
      const out = await service.setCommodityPrice('Rice', 150000, 'admin-1');
      expect(out.receiptsValued).toBe(2);
      expect(prisma.warehouseReceipt.findMany.mock.calls[0][0].where.marketValue).toBe(0);
      expect(prisma.warehouseReceipt.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { marketValue: 1500000 } });
      expect(prisma.warehouseReceipt.update).toHaveBeenCalledWith({ where: { id: 'r2' }, data: { marketValue: 375000 } });
    });

    it('deleting a price removes it by normalised key', async () => {
      await service.deleteCommodityPrice(' RICE');
      expect(prisma.commodityPrice.deleteMany).toHaveBeenCalledWith({ where: { commodity: 'rice' } });
    });
  });
});
