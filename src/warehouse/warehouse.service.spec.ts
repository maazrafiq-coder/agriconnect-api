import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { ReceiptStatus } from '@prisma/client';

// Stub — none of these tests touch invoice/GRN/gate-pass generation
// (the only paths that call into StorageService), but WarehouseService's
// constructor now requires it, so the DI container needs *something*.
const storageStub = {
  putObject: jest.fn(),
  getPresignedUrl: jest.fn(),
  deleteObject: jest.fn(),
};

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
    lien: null,
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
      },
      transaction: { create: jest.fn().mockResolvedValue({}) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: storageStub }],
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

  it('rejects a receipt that already has a lien attached', async () => {
    prisma.warehouseReceipt.findUnique.mockResolvedValue({ ...baseReceipt, lien: { id: 'existing' } });
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(BadRequestException);
  });

  it('enforces the 70% loan-to-value cap — rejects a loan above the limit', async () => {
    // 71% of 1,000,000 = 710,000 — one rupee over the 700,000 cap
    const overCap = { ...validDto, loanAmount: 710000 };
    await expect(service.applyLien('owner-1', overCap)).rejects.toThrow(
      /Maximum eligible loan is/,
    );
  });

  it('allows a loan exactly at the 70% cap', async () => {
    const atCap = { ...validDto, loanAmount: 700000 };
    await expect(service.applyLien('owner-1', atCap)).resolves.toBeDefined();
  });

  it('is idempotent: a second application on the same receipt fails cleanly', async () => {
    prisma.warehouseReceipt.updateMany.mockResolvedValueOnce({ count: 1 });
    await service.applyLien('owner-1', validDto);

    // Second call: receipt is now UNDER_LIEN, the atomic updateMany affects 0 rows
    prisma.warehouseReceipt.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow(
      'This receipt is no longer available for a new lien application',
    );
  });

  it('rolls back the receipt status to ACTIVE if lien creation fails after the status flip', async () => {
    prisma.bankLien.create.mockRejectedValue(new Error('DB constraint violation'));

    await expect(service.applyLien('owner-1', validDto)).rejects.toThrow('DB constraint violation');

    expect(prisma.warehouseReceipt.update).toHaveBeenCalledWith({
      where: { id: 'receipt-1' },
      data: { status: ReceiptStatus.ACTIVE },
    });
  });

  it('writes a LOAN_DISBURSEMENT transaction ledger entry on success', async () => {
    await service.applyLien('owner-1', validDto);
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'owner-1',
          type: 'LOAN_DISBURSEMENT',
          amount: 500000,
        }),
      }),
    );
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
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: storageStub }],
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
