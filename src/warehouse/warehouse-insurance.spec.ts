import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

describe('WarehouseService — insurance is priced by the warehouse, not the browser', () => {
  let service: WarehouseService;
  let prisma: any;
  const inDays = (n: number) => new Date(Date.now() + n * 86400_000);
  const receipt = (over: any = {}) => ({
    id: 'r1', ownerId: 'owner-1', quantityTons: 10, marketValue: 1500000, commodity: 'Rice', expiryDate: inDays(60), insurance: null,
    warehouse: { name: 'Lahore Cold Store', insuranceAvailable: true, insurancePricePerTonMonth: 150 }, ...over,
  });

  beforeEach(async () => {
    prisma = {
      warehouseReceipt: { findUnique: jest.fn().mockResolvedValue(receipt()) },
      storageInsurance: { create: jest.fn().mockResolvedValue({ id: 'i1', policySeq: 7 }), update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'i1', ...data })) },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    };
    const ref = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: {} },
        { provide: NotificationsService, useValue: { notify: jest.fn(), notifyMany: jest.fn() } },
        { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn(), getPlatformFeePct: jest.fn() } }],
    }).compile();
    service = ref.get(WarehouseService);
  });

  it('quote = rate × tons × months left; cover = receipt value; provider = the warehouse', async () => {
    const q = await service.getInsuranceQuote('owner-1', 'r1');
    expect(q).toMatchObject({ rate: 150, months: 2, coverageAmount: 1500000, premiumAmount: 3000, provider: 'Lahore Cold Store' });
  });

  it('buying ignores whatever premium/insurer/cover the client sends', async () => {
    const res: any = await service.buyInsurance('owner-1', { receiptId: 'r1', provider: 'Jubilee', premiumAmount: 1, coverageAmount: 99999999, planName: 'x', coverage: 'y' } as any);
    const data = prisma.storageInsurance.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ provider: 'Lahore Cold Store', premiumAmount: 3000, coverageAmount: 1500000 });
    expect(res.insurance.policyNumber).toMatch(/^LAH-AGR-\d{4}-000007$/);
  });

  it('refuses when the warehouse has not priced insurance, or the goods have no valuation', async () => {
    prisma.warehouseReceipt.findUnique.mockResolvedValue(receipt({ warehouse: { name: 'W', insuranceAvailable: false, insurancePricePerTonMonth: null } }));
    await expect(service.getInsuranceQuote('owner-1', 'r1')).rejects.toThrow(/not priced storage insurance/);
    prisma.warehouseReceipt.findUnique.mockResolvedValue(receipt({ marketValue: 0 }));
    await expect(service.getInsuranceQuote('owner-1', 'r1')).rejects.toThrow(/valuation pending/);
  });

  it('only the owner, and only once per receipt', async () => {
    await expect(service.getInsuranceQuote('intruder', 'r1')).rejects.toThrow(ForbiddenException);
    prisma.warehouseReceipt.findUnique.mockResolvedValue(receipt({ insurance: { id: 'x' } }));
    await expect(service.buyInsurance('owner-1', { receiptId: 'r1' } as any)).rejects.toThrow(BadRequestException);
  });
});
