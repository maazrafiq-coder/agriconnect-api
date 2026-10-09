import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { ReceiptStatus } from '@prisma/client';

// Stub — none of these tests touch invoice/GRN/gate-pass generation
// (the only paths that call into StorageService), but WarehouseService's
// constructor now requires it, so the DI container needs *something*.
const storageStub = {
  putObject: jest.fn(),
  getPresignedUrl: jest.fn(),
  deleteObject: jest.fn(),
};

// Notifications are best-effort side effects; most tests only care that they
// don't break the action. Specific tests assert on `notificationsStub.notify*`.
const notificationsStub = { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) };

/**
 * Covers WarehouseService.applyLien() — the loan-application path.
 * The 70% LTV cap is a hard business rule; a bug here means either
 * over-lending against collateral or blocking legitimate applications.
 */
describe('WarehouseService.applyLien', () => {
  let service: WarehouseService;
  let prisma: any;

  const baseReceipt = {
    id: 'receipt-1',
    receiptNumber: 'WR-2025-0001',
    ownerId: 'owner-1',
    status: ReceiptStatus.ACTIVE,
    marketValue: 1000000 as any, // ₨1,000,000
    commodity: 'Rice',
    quantityTons: 100,
    lien: null,
    warehouse: { userId: 'operator-1', name: 'Test Warehouse' },
  };

  const validDto = {
    receiptId: 'receipt-1',
    bankName: 'HBL',
    loanPurpose: 'working_capital',
    loanAmount: 500000, // within 70% cap (₨700,000)
    interestRate: 9,
    tenureMonths: 6,
  };

  beforeEach(async () => {
    prisma = {
      warehouseReceipt: {
        findUnique: jest.fn().mockResolvedValue(baseReceipt),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      bankLien: {
        create: jest.fn().mockResolvedValue({ id: 'lien-1' }),
        update: jest.fn().mockResolvedValue({ id: 'old-lien' }),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: { create: jest.fn().mockResolvedValue({}) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ profile: { fullName: 'Owner One', businessName: null } }),
        findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]),
      },
      $transaction: jest.fn().mockImplementation((arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    };
    notificationsStub.notifyMany.mockClear();
    notificationsStub.notify.mockClear();

    const moduleRef = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: storageStub }, { provide: NotificationsService, useValue: notificationsStub }, { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn().mockResolvedValue(38000), getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } }],
    }).compile();

    service = moduleRef.get(WarehouseService);
  });

  it('throws NotFoundException when the receipt does not exist', async () => {
    prisma.warehouseReceipt.findUnique.mockResolvedValue(null);
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the caller does not own the receipt', async () => {
    await expect(service.applyLien('someone-else', validDto)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a lien application on a receipt that is not ACTIVE', async () => {
    prisma.warehouseReceipt.findUnique.mockResolvedValue({ ...baseReceipt, status: ReceiptStatus.UNDER_LIEN });
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(BadRequestException);
  });

  it('rejects a receipt that already has a PENDING or ACTIVE lien attached', async () => {
    for (const status of ['PENDING', 'ACTIVE']) {
      prisma.warehouseReceipt.findUnique.mockResolvedValue({ ...baseReceipt, lien: { id: 'existing', status } });
      await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(/already exists/);
    }
  });

  it('re-uses the lien row when a previous application was REJECTED', async () => {
    prisma.warehouseReceipt.findUnique.mockResolvedValue({ ...baseReceipt, lien: { id: 'old-lien', status: 'REJECTED' } });
    await service.applyLien('owner-1', validDto);
    expect(prisma.bankLien.create).not.toHaveBeenCalled();
    expect(prisma.bankLien.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'old-lien' },
      data: expect.objectContaining({ status: 'PENDING', loanAmount: 500000, decidedById: null }),
    }));
  });

  it('refuses when no commodity price is set (valuation pending)', async () => {
    prisma.warehouseReceipt.findUnique.mockResolvedValue({ ...baseReceipt, marketValue: 0 });
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(/has not been set yet/);
    expect(prisma.bankLien.create).not.toHaveBeenCalled();
  });

  it('enforces the 70% loan-to-value cap — rejects a loan above the limit', async () => {
    const overCap = { ...validDto, loanAmount: 710000 };
    await expect(service.applyLien('owner-1', overCap)).rejects.toThrow(/Maximum eligible loan is/);
  });

  it('allows a loan exactly at the 70% cap', async () => {
    await expect(service.applyLien('owner-1', { ...validDto, loanAmount: 700000 })).resolves.toBeDefined();
  });

  it('creates a PENDING application and books NOTHING in the ledger', async () => {
    await service.applyLien('owner-1', validDto);
    expect(prisma.bankLien.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'PENDING', loanAmount: 500000 }) });
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('is idempotent: a second application on the same receipt fails cleanly', async () => {
    await service.applyLien('owner-1', validDto);
    prisma.warehouseReceipt.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(
      'This receipt is no longer available for a new lien application',
    );
  });

  it('is atomic: a failed lien insert aborts the whole transaction (no manual rollback needed)', async () => {
    prisma.bankLien.create.mockRejectedValue(new Error('DB constraint violation'));
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow('DB constraint violation');
    expect(notificationsStub.notifyMany).not.toHaveBeenCalled();
  });

  it('notifies the operator, the owner AND admin/moderator reviewers', async () => {
    await service.applyLien('owner-1', validDto);
    const sent = notificationsStub.notifyMany.mock.calls[0][0];
    const toOperator = sent.find((n: any) => n.userId === 'operator-1');
    const toOwner = sent.find((n: any) => n.userId === 'owner-1');
    const toAdmin = sent.find((n: any) => n.userId === 'admin-1');
    expect(toOperator.body).toMatch(/gate-out is blocked/i);
    expect(toOperator.body).toContain('HBL');
    expect(toOwner.title).toMatch(/submitted/i);
    expect(toAdmin.title).toMatch(/awaiting confirmation/i);
  });

  describe('withdrawLien', () => {
    const pending = { id: 'lien-1', status: 'PENDING', receiptId: 'receipt-1', receipt: { ownerId: 'owner-1', receiptNumber: 'WR-1', warehouse: { userId: 'operator-1' } } };

    it('lets the owner withdraw a PENDING application and frees the receipt', async () => {
      prisma.bankLien.findUnique.mockResolvedValue(pending);
      await service.withdrawLien('lien-1', 'owner-1');
      expect(prisma.bankLien.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'WITHDRAWN' }) }));
      expect(prisma.warehouseReceipt.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACTIVE' } }));
    });

    it('refuses someone else, and anything that is not PENDING', async () => {
      prisma.bankLien.findUnique.mockResolvedValue(pending);
      await expect(service.withdrawLien('lien-1', 'intruder')).rejects.toThrow(ForbiddenException);
      prisma.bankLien.findUnique.mockResolvedValue({ ...pending, status: 'ACTIVE' });
      await expect(service.withdrawLien('lien-1', 'owner-1')).rejects.toThrow(/Only a pending/);
    });
  });

  describe('confirmLien / rejectLien', () => {
    const pending = {
      id: 'lien-1', status: 'PENDING', receiptId: 'receipt-1', bankName: 'HBL', loanAmount: 500000,
      receipt: { ownerId: 'owner-1', receiptNumber: 'WR-1', warehouse: { userId: 'operator-1', name: 'W' } },
    };

    it('confirm: PENDING → ACTIVE and books LOAN_DISBURSEMENT for the owner', async () => {
      prisma.bankLien.findUnique.mockResolvedValue(pending);
      await service.confirmLien('lien-1', 'admin-1', { loanRefNo: 'HBL-778', interestRate: 11 } as any);
      expect(prisma.bankLien.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'lien-1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'ACTIVE', loanRefNo: 'HBL-778', interestRate: 11, decidedById: 'admin-1' }),
      }));
      expect(prisma.transaction.create.mock.calls[0][0].data).toMatchObject({ userId: 'owner-1', type: 'LOAN_DISBURSEMENT', amount: 500000, referenceId: 'lien-1' });
    });

    it('confirm: needs a loan reference and a PENDING application; double-confirm books nothing', async () => {
      prisma.bankLien.findUnique.mockResolvedValue(pending);
      await expect(service.confirmLien('lien-1', 'admin-1', { loanRefNo: ' x ' } as any)).rejects.toThrow(/reference/);
      prisma.bankLien.findUnique.mockResolvedValue({ ...pending, status: 'ACTIVE' });
      await expect(service.confirmLien('lien-1', 'admin-1', { loanRefNo: 'HBL-778' } as any)).rejects.toThrow(/Only a pending/);
      prisma.bankLien.findUnique.mockResolvedValue(pending);
      prisma.bankLien.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.confirmLien('lien-1', 'admin-1', { loanRefNo: 'HBL-778' } as any)).rejects.toThrow(/just decided/);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('reject: needs a reason, flips to REJECTED, frees the receipt, books nothing', async () => {
      prisma.bankLien.findUnique.mockResolvedValue(pending);
      await expect(service.rejectLien('lien-1', 'admin-1', 'no')).rejects.toThrow();
      await service.rejectLien('lien-1', 'admin-1', 'Insufficient documentation');
      expect(prisma.bankLien.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }));
      expect(prisma.warehouseReceipt.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACTIVE' } }));
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });
});

/**
 * Round 2, Milestone 6 — provider account fixes. adminVerify previously
 * had no existence guard (unlike its sibling adminSetActive) and would
 * fall straight through to a raw Prisma "record not found" error on a
 * missing warehouse instead of a clean 404 — this covers the fix.
 */
describe('WarehouseService.adminVerify', () => {
  let service: WarehouseService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      warehouseProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wh-1', isVerified: false }),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: storageStub }, { provide: NotificationsService, useValue: notificationsStub }, { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn().mockResolvedValue(38000), getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } }],
    }).compile();
    service = moduleRef.get(WarehouseService);
  });

  it('marks an existing warehouse as verified', async () => {
    const result = await service.adminVerify('wh-1', true);
    expect(prisma.warehouseProfile.update).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      data: { isVerified: true },
    });
    expect(result.isVerified).toBe(true);
  });

  it('404s on a missing warehouse rather than a raw Prisma error', async () => {
    prisma.warehouseProfile.findUnique.mockResolvedValue(null);
    await expect(service.adminVerify('ghost-wh', true)).rejects.toThrow(NotFoundException);
    expect(prisma.warehouseProfile.update).not.toHaveBeenCalled();
  });
});
