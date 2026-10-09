import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WarehouseService } from './warehouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

// Notifications are best-effort side effects; most tests only care that they
// don't break the action. Specific tests assert on `notificationsStub.notify*`.
const notificationsStub = { notify: jest.fn().mockResolvedValue(undefined), notifyMany: jest.fn().mockResolvedValue(undefined) };

/**
 * Covers the invoice / Goods Receipt Note / Gate Out Pass workflow added
 * for NEW_Changes item 10. PDF rendering itself (pdfkit) runs for real
 * here rather than being mocked — it's pure JS with no I/O, so there's no
 * reason not to catch a broken renderPdfDocument() call via these tests
 * too. Only the storage upload and the DB are stubbed.
 */
describe('WarehouseService — documents (invoice / GRN / gate-out pass)', () => {
  let service: WarehouseService;
  let prisma: any;
  let storage: any;

  const booking = {
    id: 'booking-1',
    bookingSeq: 1,
    warehouseId: 'wh-1',
    depositorId: 'depositor-1',
    commodity: 'Rice',
    variety: 'Basmati',
    quantityTons: 50,
    durationDays: 60,
    pricePerTon: 200 as any,
    insuranceCost: 5000 as any,
    totalCost: 605000 as any,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01'),
    warehouse: { id: 'wh-1', userId: 'operator-1', name: 'Test Warehouse', address: '123 Main St', city: 'Lahore', province: 'Punjab' },
  };

  beforeEach(async () => {
    prisma = {
      storageBooking: { findUnique: jest.fn().mockResolvedValue(booking) },
      warehouseProfile: { findUnique: jest.fn().mockResolvedValue(booking.warehouse), findMany: jest.fn().mockResolvedValue([{ id: 'wh-1' }]) },
      user: { findUnique: jest.fn().mockResolvedValue({ profile: { fullName: 'Depositor One', address: '', city: '' } }) },
      warehouseInvoice: {
        findUnique: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => {
          const record = { id: 'inv-1', invoiceSeq: 7, issuedAt: new Date('2026-02-01'), status: 'UNPAID', ...data };
          prisma.warehouseInvoice.__record = record;
          return Promise.resolve(record);
        }),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...prisma.warehouseInvoice.__record, ...data })),
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      transaction: { createMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn() },
      $transaction: jest.fn().mockImplementation((arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
      gateOutPass: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'pass-1', passSeq: 3, status: 'PENDING', ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'pass-1', ...data })),
        findMany: jest.fn(),
      },
      // No receipt/lien by default → gate-out isn't blocked. Lien tests override.
      warehouseReceipt: { findUnique: jest.fn().mockResolvedValue(null) },
      goodsReceiptNote: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'grn-1', grnSeq: 2, receivedAt: new Date('2026-02-01'), ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'grn-1', ...data })),
      },
    };
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      getPresignedUrl: jest.fn().mockResolvedValue('https://signed.example/doc.pdf'),
      deleteObject: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [WarehouseService, { provide: PrismaService, useValue: prisma }, { provide: StorageService, useValue: storage }, { provide: NotificationsService, useValue: notificationsStub }, { provide: SettingsService, useValue: { getCommodityPricePerTon: jest.fn().mockResolvedValue(38000), getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } }],
    }).compile();
    service = moduleRef.get(WarehouseService);
  });

  describe('generateInvoice', () => {
    it('generates a PDF, uploads it, and stores the invoice with the right total', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...booking, invoice: null });
      const result = await service.generateInvoice('operator-1', 'booking-1');

      expect(storage.putObject).toHaveBeenCalledWith(expect.stringContaining('invoice-'), expect.any(Buffer), 'application/pdf');
      expect(result.invoiceNumber).toMatch(/^INV-2026-\d{6}$/);
      expect(result.totalAmount).toBe(605000);
      expect(result.storageCost).toBe(600000); // totalCost minus insuranceCost
    });

    it('rejects a non-owner operator', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...booking, invoice: null });
      await expect(service.generateInvoice('someone-else', 'booking-1')).rejects.toThrow(ForbiddenException);
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('refuses to generate a second invoice for the same booking', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...booking, invoice: { id: 'existing' } });
      await expect(service.generateInvoice('operator-1', 'booking-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('confirmInvoicePayment', () => {
    const invoice = {
      id: 'inv-1', status: 'UNPAID', invoiceNumber: 'INV-2026-000007', bookingId: 'booking-1', depositorId: 'depositor-1',
      storageCost: 120000, insuranceCost: 5000, warehouse: { userId: 'operator-1' }, booking: { status: 'ACCEPTED' },
    };
    const paidAfter = (extra: any = {}) => ({ ...invoice, status: 'PAID', ...extra });

    beforeEach(() => {
      // 1st findUnique = pre-check (UNPAID), 2nd = re-read inside the transaction.
      prisma.warehouseInvoice.findUnique.mockResolvedValueOnce(invoice);
    });

    it('lets the owning operator confirm payment and books the ledger rows', async () => {
      prisma.warehouseInvoice.findUnique.mockResolvedValueOnce(paidAfter({ paymentReference: 'TXN-123' }));
      const result: any = await service.confirmInvoicePayment('operator-1', 'WAREHOUSE', 'inv-1', 'TXN-123');
      expect(result.status).toBe('PAID');
      expect(result.paymentReference).toBe('TXN-123');
      const rows = prisma.transaction.createMany.mock.calls[0][0].data;
      expect(rows.map((r: any) => r.type)).toEqual(['STORAGE_FEE', 'INSURANCE_PREMIUM']);
      expect(rows[0]).toMatchObject({ userId: 'depositor-1', amount: 120000, referenceId: 'booking-1' });
    });

    it('skips the insurance row when there is no premium', async () => {
      prisma.warehouseInvoice.findUnique.mockReset();
      prisma.warehouseInvoice.findUnique.mockResolvedValueOnce({ ...invoice, insuranceCost: 0 }).mockResolvedValueOnce(paidAfter());
      await service.confirmInvoicePayment('operator-1', 'WAREHOUSE', 'inv-1');
      expect(prisma.transaction.createMany.mock.calls[0][0].data).toHaveLength(1);
    });

    it('lets an admin confirm payment even if not the warehouse owner', async () => {
      prisma.warehouseInvoice.findUnique.mockResolvedValueOnce(paidAfter());
      const result: any = await service.confirmInvoicePayment('admin-1', 'ADMIN', 'inv-1', undefined);
      expect(result.status).toBe('PAID');
    });

    it('rejects an unrelated user', async () => {
      await expect(service.confirmInvoicePayment('random-user', 'BUYER', 'inv-1')).rejects.toThrow(ForbiddenException);
      expect(prisma.transaction.createMany).not.toHaveBeenCalled();
    });

    it('refuses to re-confirm an already-paid invoice', async () => {
      prisma.warehouseInvoice.findUnique.mockReset();
      prisma.warehouseInvoice.findUnique.mockResolvedValue({ ...invoice, status: 'PAID' });
      await expect(service.confirmInvoicePayment('operator-1', 'WAREHOUSE', 'inv-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses to book a double-click: guarded flip finds nothing to update', async () => {
      prisma.warehouseInvoice.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.confirmInvoicePayment('operator-1', 'WAREHOUSE', 'inv-1')).rejects.toThrow(/already marked as paid/);
      expect(prisma.transaction.createMany).not.toHaveBeenCalled();
    });

    it('refuses payment on a cancelled booking', async () => {
      prisma.warehouseInvoice.findUnique.mockReset();
      prisma.warehouseInvoice.findUnique.mockResolvedValue({ ...invoice, booking: { status: 'CANCELLED' } });
      await expect(service.confirmInvoicePayment('operator-1', 'WAREHOUSE', 'inv-1')).rejects.toThrow(/cancelled/);
    });
  });

  describe('requestGateOut', () => {
    it('refuses to request release before goods are ACTIVE in storage', async () => {
      prisma.storageBooking.findUnique.mockResolvedValue({ ...booking, status: 'ACCEPTED' });
      await expect(service.requestGateOut('operator-1', 'booking-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses a second pending request for the same booking', async () => {
      prisma.gateOutPass.findFirst.mockResolvedValue({ id: 'existing-pending' });
      await expect(service.requestGateOut('operator-1', 'booking-1')).rejects.toThrow(BadRequestException);
    });

    it('creates a PENDING request defaulting to the full booked quantity', async () => {
      const result = await service.requestGateOut('operator-1', 'booking-1');
      expect(result.quantityTons).toBe(50);
      expect(result.status ?? 'PENDING').toBe('PENDING');
    });
  });

  describe('bank lien blocks gate-out until clearance is recorded', () => {
    const lienReceipt = (status: string) => ({ id: 'r-1', lien: { id: 'lien-1', bankName: 'NBP', loanAmount: 4000000, status } });

    it('refuses to request gate-out while an ACTIVE lien exists, naming the bank', async () => {
      prisma.warehouseReceipt.findUnique.mockResolvedValue(lienReceipt('ACTIVE'));
      await expect(service.requestGateOut('operator-1', 'booking-1')).rejects.toThrow(/NBP.*clearance/);
      expect(prisma.gateOutPass.create).not.toHaveBeenCalled();
    });

    it('allows the request once the lien is RELEASED', async () => {
      prisma.warehouseReceipt.findUnique.mockResolvedValue(lienReceipt('RELEASED'));
      await expect(service.requestGateOut('operator-1', 'booking-1')).resolves.toBeDefined();
    });

    it('refuses to approve a pending pass if a lien was placed after the request', async () => {
      prisma.gateOutPass.findUnique.mockResolvedValue({
        id: 'pass-1', passSeq: 3, status: 'PENDING', depositorId: 'depositor-1', bookingId: 'booking-1',
        quantityTons: 50, booking: { commodity: 'Rice' }, warehouse: { userId: 'operator-1', name: 'W' },
      });
      prisma.warehouseReceipt.findUnique.mockResolvedValue(lienReceipt('ACTIVE'));
      await expect(service.approveGateOut('depositor-1', 'BUYER', 'pass-1')).rejects.toThrow(BadRequestException);
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('notifies the depositor when the warehouse requests release', async () => {
      notificationsStub.notify.mockClear();
      await service.requestGateOut('operator-1', 'booking-1');
      expect(notificationsStub.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'depositor-1', title: 'Release of your goods requested' }));
    });
  });

  describe('approveGateOut / rejectGateOut', () => {
    const pendingPass = {
      id: 'pass-1', passSeq: 3, status: 'PENDING', depositorId: 'depositor-1', bookingId: 'booking-1',
      quantityTons: 50, booking: { commodity: 'Rice', variety: 'Basmati' },
      warehouse: { userId: 'operator-1', name: 'Test Warehouse', address: '123 Main St', city: 'Lahore', province: 'Punjab' },
    };

    it('lets the depositor approve their own gate-out request', async () => {
      prisma.gateOutPass.findUnique.mockResolvedValue(pendingPass);
      const result = await service.approveGateOut('depositor-1', 'BUYER', 'pass-1');
      expect(result.status).toBe('APPROVED');
      expect(result.approverRole).toBe('DEPOSITOR');
      expect(result.passNumber).toMatch(/^GOP-\d{4}-\d{6}$/);
      expect(storage.putObject).toHaveBeenCalledWith(expect.stringContaining('gate-pass-'), expect.any(Buffer), 'application/pdf');
    });

    it('lets an admin approve on the depositor\'s behalf', async () => {
      prisma.gateOutPass.findUnique.mockResolvedValue(pendingPass);
      const result = await service.approveGateOut('admin-1', 'ADMIN', 'pass-1');
      expect(result.status).toBe('APPROVED');
      expect(result.approverRole).toBe('ADMIN');
    });

    it('refuses approval from an unrelated user (not the depositor, not an admin)', async () => {
      prisma.gateOutPass.findUnique.mockResolvedValue(pendingPass);
      await expect(service.approveGateOut('random-user', 'BUYER', 'pass-1')).rejects.toThrow(ForbiddenException);
    });

    it('refuses to approve an already-decided request', async () => {
      prisma.gateOutPass.findUnique.mockResolvedValue({ ...pendingPass, status: 'REJECTED' });
      await expect(service.approveGateOut('depositor-1', 'BUYER', 'pass-1')).rejects.toThrow(BadRequestException);
    });

    it('lets the depositor reject with a note, without generating a PDF', async () => {
      prisma.gateOutPass.findUnique.mockResolvedValue(pendingPass);
      const result = await service.rejectGateOut('depositor-1', 'BUYER', 'pass-1', 'Wrong quantity');
      expect(result.status).toBe('REJECTED');
      expect(result.rejectionNote).toBe('Wrong quantity');
      expect(storage.putObject).not.toHaveBeenCalled();
    });
  });
});
