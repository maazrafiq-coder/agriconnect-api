/**
 * Warehouse money paths against a REAL Postgres: booking → accept → receipt,
 * loan application → admin confirm → gate-out blocked → clearance → gate-out →
 * complete, storage insurance, invoice payment (ledger rows + races).
 *
 * NOT executed in the authoring sandbox — see MIGRATION_NOTES_R3_M7.md.
 */
import { PrismaClient } from '@prisma/client';
import { buildServices, connect, describeDb, ledger, makeUser, makeWarehouse, sum } from './helpers/integration';

describeDb('Warehouse, lien, gate-out, insurance & invoices (real database)', () => {
  let prisma: PrismaClient;
  let svc: ReturnType<typeof buildServices>;
  let admin: any, operator: any, depositor: any, wh: any;

  const ENTRY = () => new Date().toISOString();
  const RICE_PRICE = 100000; // ₨ per ton

  beforeAll(async () => {
    prisma = await connect();
    svc = buildServices(prisma);
    admin = await makeUser(prisma, 'ADMIN');
    operator = await makeUser(prisma, 'WAREHOUSE');
    depositor = await makeUser(prisma, 'BUYER');
    wh = await makeWarehouse(prisma, operator.id, { insuranceAvailable: true, insurancePricePerTonMonth: 500 });
    await svc.settings.setCommodityPrice('Rice', RICE_PRICE, admin.id);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  /** booking → accepted → receipt issued (booking ACTIVE). 10 t of Rice, 60 days. */
  async function storedGoods(tons = 10) {
    const { booking } = (await svc.warehouse.bookStorage(depositor.id, {
      warehouseId: wh.id, commodity: 'Rice', quantityTons: tons, entryDate: ENTRY(), durationDays: 60,
    } as any)) as any;
    await svc.warehouse.acceptBooking(operator.id, booking.id);
    const receipt: any = await svc.warehouse.issueReceipt(operator.id, booking.id, { moisture: 12 }, tons);
    return { bookingId: booking.id as string, receipt };
  }

  it('books, accepts and issues a receipt valued from the admin price table; booking becomes ACTIVE', async () => {
    const { bookingId, receipt } = await storedGoods(10);
    expect(Number(receipt.marketValue)).toBe(10 * RICE_PRICE);
    expect(receipt.receiptNumber).toMatch(/^WR-/);
    const b = await prisma.storageBooking.findUnique({ where: { id: bookingId } });
    expect(b?.status).toBe('ACTIVE');
    expect(await prisma.goodsReceiptNote.count({ where: { bookingId } })).toBe(1);
  });

  it('refuses a booking that exceeds capacity (capacity lock), and two simultaneous requests cannot oversell', async () => {
    const small = await makeWarehouse(prisma, operator.id, { totalCapacityTons: 15 });
    const book = () => svc.warehouse.bookStorage(depositor.id, {
      warehouseId: small.id, commodity: 'Rice', quantityTons: 10, entryDate: ENTRY(), durationDays: 30,
    } as any);
    const results = await Promise.allSettled([book(), book()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });

  describe('loan application (lien)', () => {
    it('is capped at 70% of the receipt value', async () => {
      const { receipt } = await storedGoods(10); // value 1,000,000 → max 700,000
      await expect(svc.warehouse.applyLien(depositor.id, {
        receiptId: receipt.id, bankName: 'HBL', loanPurpose: 'Working capital', loanAmount: 800000, interestRate: 12, tenureMonths: 6,
      } as any)).rejects.toThrow(/Maximum eligible loan/);
    });

    it('apply → PENDING (receipt frozen, nothing booked) → gate-out blocked → admin confirms → ACTIVE + disbursement booked once', async () => {
      const { bookingId, receipt } = await storedGoods(10);
      const applied: any = await svc.warehouse.applyLien(depositor.id, {
        receiptId: receipt.id, bankName: 'HBL', loanPurpose: 'Working capital', loanAmount: 600000, interestRate: 12, tenureMonths: 6,
      } as any);
      const lienId = applied.lien.id as string;

      expect((await prisma.bankLien.findUnique({ where: { id: lienId } }))?.status).toBe('PENDING');
      expect((await prisma.warehouseReceipt.findUnique({ where: { id: receipt.id } }))?.status).toBe('UNDER_LIEN');
      expect(await prisma.transaction.count({ where: { referenceId: lienId } })).toBe(0);
      await expect(svc.warehouse.requestGateOut(operator.id, bookingId)).rejects.toThrow(/pending|lien/i);

      // Two admins click Confirm at the same moment.
      const results = await Promise.allSettled([
        svc.warehouse.confirmLien(lienId, admin.id, { loanRefNo: 'HBL-2026-001' } as any),
        svc.warehouse.confirmLien(lienId, admin.id, { loanRefNo: 'HBL-2026-001' } as any),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((await prisma.bankLien.findUnique({ where: { id: lienId } }))?.status).toBe('ACTIVE');
      const disb = await prisma.transaction.findMany({ where: { referenceId: lienId, type: 'LOAN_DISBURSEMENT' as any } });
      expect(disb).toHaveLength(1);
      expect(Number(disb[0].amount)).toBe(600000);

      // Still blocked while the lien is active, and the booking cannot be completed.
      await expect(svc.warehouse.requestGateOut(operator.id, bookingId)).rejects.toThrow(/lien/i);
      await expect(svc.warehouse.completeBooking(operator.id, bookingId)).rejects.toThrow();
    });

    it('clearance (race-safe) books the repayment once, frees the receipt, and then gate-out → complete works', async () => {
      const { bookingId, receipt } = await storedGoods(10);
      const applied: any = await svc.warehouse.applyLien(depositor.id, {
        receiptId: receipt.id, bankName: 'NBP', loanPurpose: 'Seed', loanAmount: 500000, interestRate: 11, tenureMonths: 3,
      } as any);
      const lienId = applied.lien.id as string;
      await svc.warehouse.confirmLien(lienId, admin.id, { loanRefNo: 'NBP-77' } as any);

      const results = await Promise.allSettled([
        svc.warehouse.releaseLien(lienId, operator.id, 'WAREHOUSE', 'NBP/REL/1'),
        svc.warehouse.releaseLien(lienId, admin.id, 'ADMIN', 'NBP/REL/1'),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const repay = await prisma.transaction.findMany({ where: { referenceId: lienId, type: 'LOAN_REPAYMENT' as any } });
      expect(repay).toHaveLength(1);
      expect((await prisma.warehouseReceipt.findUnique({ where: { id: receipt.id } }))?.status).toBe('ACTIVE');

      // Completing before the depositor approves a gate-out pass is refused.
      const pass: any = await svc.warehouse.requestGateOut(operator.id, bookingId);
      await expect(svc.warehouse.completeBooking(operator.id, bookingId)).rejects.toThrow(/gate-out/i);
      const approved: any = await svc.warehouse.approveGateOut(depositor.id, 'BUYER', pass.id);
      expect(approved.status).toBe('APPROVED');
      expect(approved.passNumber).toMatch(/^GOP-/);
      await svc.warehouse.completeBooking(operator.id, bookingId);

      expect((await prisma.storageBooking.findUnique({ where: { id: bookingId } }))?.status).toBe('COMPLETED');
      expect((await prisma.warehouseReceipt.findUnique({ where: { id: receipt.id } }))?.status).toBe('RELEASED');
    });

    it('decline frees the receipt, books nothing, and a new application can reuse the receipt', async () => {
      const { receipt } = await storedGoods(10);
      const first: any = await svc.warehouse.applyLien(depositor.id, {
        receiptId: receipt.id, bankName: 'ABL', loanPurpose: 'x', loanAmount: 100000, interestRate: 10, tenureMonths: 2,
      } as any);
      await svc.warehouse.rejectLien(first.lien.id, admin.id, 'Insufficient documents');
      expect((await prisma.warehouseReceipt.findUnique({ where: { id: receipt.id } }))?.status).toBe('ACTIVE');
      expect(await prisma.transaction.count({ where: { referenceId: first.lien.id } })).toBe(0);
      const second: any = await svc.warehouse.applyLien(depositor.id, {
        receiptId: receipt.id, bankName: 'ABL', loanPurpose: 'y', loanAmount: 100000, interestRate: 10, tenureMonths: 2,
      } as any);
      expect(second.lien.status).toBe('PENDING');
    });

    it('two simultaneous applications on one receipt create one lien', async () => {
      const { receipt } = await storedGoods(10);
      const apply = () => svc.warehouse.applyLien(depositor.id, {
        receiptId: receipt.id, bankName: 'MCB', loanPurpose: 'x', loanAmount: 100000, interestRate: 10, tenureMonths: 2,
      } as any);
      const results = await Promise.allSettled([apply(), apply()]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.bankLien.count({ where: { receiptId: receipt.id } })).toBe(1);
    });
  });

  describe('storage insurance', () => {
    it('is priced server-side from the warehouse rate × tons × months left; cover = receipt value; client numbers are ignored', async () => {
      const { receipt } = await storedGoods(10);
      const quote: any = await svc.warehouse.getInsuranceQuote(depositor.id, receipt.id);
      expect(quote.rate).toBe(500);
      expect(quote.coverageAmount).toBe(10 * RICE_PRICE);
      expect(quote.premiumAmount).toBe(500 * 10 * quote.months);

      const bought: any = await svc.warehouse.buyInsurance(depositor.id, {
        receiptId: receipt.id, provider: 'Fake Insurer', premiumAmount: 1, coverageAmount: 1,
      } as any);
      expect(Number(bought.insurance.premiumAmount)).toBe(quote.premiumAmount);
      expect(Number(bought.insurance.coverageAmount)).toBe(quote.coverageAmount);
      expect(bought.insurance.provider).not.toBe('Fake Insurer');
      expect(bought.insurance.policyNumber).not.toMatch(/^TMP-/);
    });

    it('a double-click buys exactly one policy', async () => {
      const { receipt } = await storedGoods(10);
      const buy = () => svc.warehouse.buyInsurance(depositor.id, { receiptId: receipt.id } as any);
      const results = await Promise.allSettled([buy(), buy()]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.storageInsurance.count({ where: { receiptId: receipt.id } })).toBe(1);
    });

    it('is refused when the warehouse has no insurance rate', async () => {
      const bare = await makeWarehouse(prisma, operator.id, { insuranceAvailable: false });
      const { booking } = (await svc.warehouse.bookStorage(depositor.id, {
        warehouseId: bare.id, commodity: 'Rice', quantityTons: 5, entryDate: ENTRY(), durationDays: 30,
      } as any)) as any;
      await svc.warehouse.acceptBooking(operator.id, booking.id);
      const receipt: any = await svc.warehouse.issueReceipt(operator.id, booking.id, {}, 5);
      await expect(svc.warehouse.buyInsurance(depositor.id, { receiptId: receipt.id } as any)).rejects.toThrow(/not priced|insurance/i);
    });
  });

  describe('invoice payment', () => {
    it('confirming payment books the storage fee once, even if two people confirm at the same time', async () => {
      const { booking } = (await svc.warehouse.bookStorage(depositor.id, {
        warehouseId: wh.id, commodity: 'Rice', quantityTons: 4, entryDate: ENTRY(), durationDays: 30, includeInsurance: true,
      } as any)) as any;
      await svc.warehouse.acceptBooking(operator.id, booking.id);
      const invoice: any = await svc.warehouse.generateInvoice(operator.id, booking.id);
      expect(invoice.invoiceNumber).toMatch(/^INV-/);

      const before = (await ledger(prisma, depositor.id)).length;
      const results = await Promise.allSettled([
        svc.warehouse.confirmInvoicePayment(operator.id, 'WAREHOUSE', invoice.id, 'REF-1'),
        svc.warehouse.confirmInvoicePayment(admin.id, 'ADMIN', invoice.id, 'REF-1'),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const rows = (await prisma.transaction.findMany({ where: { referenceId: booking.id } }));
      expect(rows.filter((r: any) => r.type === 'STORAGE_FEE')).toHaveLength(1);
      expect(rows.filter((r: any) => r.type === 'INSURANCE_PREMIUM')).toHaveLength(1);
      expect(sum(rows)).toBeCloseTo(Number(invoice.totalAmount), 2);
      expect((await ledger(prisma, depositor.id)).length).toBe(before + 2);
    });

    it('cancelling after payment writes a REFUND for the invoice total', async () => {
      const { booking } = (await svc.warehouse.bookStorage(depositor.id, {
        warehouseId: wh.id, commodity: 'Rice', quantityTons: 3, entryDate: ENTRY(), durationDays: 30,
      } as any)) as any;
      await svc.warehouse.acceptBooking(operator.id, booking.id);
      const invoice: any = await svc.warehouse.generateInvoice(operator.id, booking.id);
      await svc.warehouse.confirmInvoicePayment(operator.id, 'WAREHOUSE', invoice.id, 'REF-2');
      await svc.warehouse.cancelBooking(depositor.id, 'BUYER', booking.id, { reason: 'Changed plans entirely' } as any);
      const refunds = await prisma.transaction.findMany({ where: { referenceId: booking.id, type: 'REFUND' as any } });
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0].amount)).toBeCloseTo(Number(invoice.totalAmount), 2);
    });
  });
});
