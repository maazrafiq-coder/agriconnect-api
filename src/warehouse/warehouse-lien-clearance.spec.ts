import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

const notificationsStub = { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) };

/**
 * Recording the bank's clearance of a lien. Only the warehouse holding the
 * goods or an admin/moderator may do it — never the depositor, who would be
 * clearing their own collateral.
 */
describe('WarehouseService.releaseLien (bank clearance)', () => {
  let service: WarehouseService;
  let prisma: any;

  const lien = (status = 'ACTIVE') => ({
    id: 'lien-1', status, bankName: 'NBP', receiptId: 'r-1',
    loanAmount: 500000,
    receipt: { ownerId: 'owner-1', receiptNumber: 'WR-2026-0001', warehouse: { userId: 'operator-1', name: 'WH' } },
  });

  beforeEach(async () => {
    notificationsStub.notifyMany.mockClear();
    prisma = {
      bankLien: { findUnique: jest.fn().mockResolvedValue(lien()), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      warehouseReceipt: { update: jest.fn().mockResolvedValue({}) },
      transaction: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        WarehouseService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: {} },
        { provide: NotificationsService, useValue: notificationsStub }, { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn().mockResolvedValue(38000), getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } },
      ],
    }).compile();
    service = moduleRef.get(WarehouseService);
  });

  it('404s for an unknown lien', async () => {
    prisma.bankLien.findUnique.mockResolvedValue(null);
    await expect(service.releaseLien('x', 'operator-1', 'WAREHOUSE', 'REF-1')).rejects.toThrow(NotFoundException);
  });

  it('does NOT let the depositor clear their own lien', async () => {
    await expect(service.releaseLien('lien-1', 'owner-1', 'BUYER', 'REF-1')).rejects.toThrow(ForbiddenException);
    expect(prisma.bankLien.updateMany).not.toHaveBeenCalled();
  });

  it('does not let an unrelated warehouse operator clear it either', async () => {
    await expect(service.releaseLien('lien-1', 'other-operator', 'WAREHOUSE', 'REF-1')).rejects.toThrow(ForbiddenException);
  });

  it('requires the bank clearance reference', async () => {
    await expect(service.releaseLien('lien-1', 'operator-1', 'WAREHOUSE', '   ')).rejects.toThrow(BadRequestException);
    await expect(service.releaseLien('lien-1', 'operator-1', 'WAREHOUSE', undefined)).rejects.toThrow(BadRequestException);
  });

  it.each(['RELEASED', 'PENDING', 'REJECTED', 'WITHDRAWN'])('refuses to release a lien that is %s (only an ACTIVE lien can be cleared)', async (st) => {
    prisma.bankLien.findUnique.mockResolvedValue(lien(st));
    await expect(service.releaseLien('lien-1', 'operator-1', 'WAREHOUSE', 'REF-1')).rejects.toThrow(BadRequestException);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('loses cleanly to a concurrent clearance: no repayment is booked twice', async () => {
    prisma.bankLien.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.releaseLien('lien-1', 'operator-1', 'WAREHOUSE', 'REF-1')).rejects.toThrow(BadRequestException);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(notificationsStub.notifyMany).not.toHaveBeenCalled();
  });

  it.each([['operator-1', 'WAREHOUSE'], ['admin-1', 'ADMIN'], ['mod-1', 'MODERATOR']])(
    'lets %s (%s) record clearance, frees the receipt, and notifies both sides',
    async (userId, role) => {
      await service.releaseLien('lien-1', userId, role, ' NBP/REL/2026/118 ');
      expect(prisma.bankLien.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'lien-1', status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'RELEASED', releaseNote: 'NBP/REL/2026/118' }),
      }));
      expect(prisma.warehouseReceipt.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACTIVE' } }));
      // Clearance = the bank was repaid -> exactly one LOAN_REPAYMENT row for the owner.
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create.mock.calls[0][0].data).toMatchObject({
        userId: 'owner-1', type: 'LOAN_REPAYMENT', amount: 500000, referenceId: 'lien-1', referenceType: 'lien',
      });
      const sent = notificationsStub.notifyMany.mock.calls[0][0];
      expect(sent.map((n: any) => n.userId).sort()).toEqual(['operator-1', 'owner-1']);
    },
  );
});
