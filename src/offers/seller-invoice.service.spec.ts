import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SellerInvoiceService } from './seller-invoice.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { makeFakePrisma } from './__testing__/fake-prisma';

async function setup(terms: any = { type: 'CREDIT', creditDays: 30, creditStart: 'DELIVERY_ACK' }) {
  const db = makeFakePrisma();
  const notify = jest.fn().mockResolvedValue(undefined);
  const stored: Record<string, Buffer> = {};
  const storage = {
    putObject: jest.fn(async (k: string, b: Buffer) => { stored[k] = b; }),
    getPresignedUrl: jest.fn(async (k: string) => `https://signed.example/${k}`),
  };
  const mod = await Test.createTestingModule({
    providers: [
      SellerInvoiceService,
      { provide: PrismaService, useValue: db },
      { provide: StorageService, useValue: storage },
      { provide: NotificationsService, useValue: { notify, notifyMany: jest.fn() } },
    ],
  }).compile();
  const service = mod.get(SellerInvoiceService);
  db.user.seed({ id: 'seller-1', profile: { fullName: 'Seller Sam', businessName: 'Sam Rice Mills', address: '1 Mill Rd', city: 'Gujranwala' } });
  db.user.seed({ id: 'buyer-1', profile: { fullName: 'Buyer Bo', businessName: null, address: '9 Port St', city: 'Karachi' } });
  db.product.seed({ id: 'prod-1', sellerId: 'seller-1', name: 'Super Kernel Basmati', unit: 'kg' });
  db.offer.seed({ id: 'offer-1', productId: 'prod-1', buyerId: 'buyer-1', quantity: 1000, offeredPrice: 250 });
  const order = db.order.seed({
    id: 'order-1', offerId: 'offer-1', sellerId: 'seller-1', buyerId: 'buyer-1', status: 'CONFIRMED',
    totalAmount: 250000, platformFeePct: 1.5, platformFee: 3750, netSellerAmount: 246250,
    unitPrice: 250, quantity: 1000, paymentTermsSnapshot: terms,
  });
  return { db, service, notify, storage, stored, order };
}

describe('SellerInvoiceService.issue', () => {
  it('issues an invoice for the FULL order amount, with number, version 1, terms and a PDF', async () => {
    const s = await setup();
    const inv: any = await s.service.issue('seller-1', 'order-1');
    expect(inv).toMatchObject({ orderAmount: 250000, status: 'ISSUED', version: 1, sellerId: 'seller-1', buyerId: 'buyer-1' });
    expect(inv.invoiceNumber).toMatch(/^SINV-\d{4}-000001$/);
    expect(inv.termsSummary).toMatch(/30 days after delivery acknowledgement/);
    expect(inv.itemDescription).toMatch(/Super Kernel Basmati - 1000 kg @/);
    expect(inv.downloadUrl).toMatch(/^https:\/\/signed\.example\/seller-invoices\//);
    const pdf = Object.values(s.stored)[0];
    expect(pdf.slice(0, 4).toString()).toBe('%PDF');
  });

  it('shows the platform-fee / seller-net settlement ONLY to the seller (D5)', async () => {
    const s = await setup();
    const forSeller: any = await s.service.issue('seller-1', 'order-1');
    expect(forSeller.sellerSettlement).toEqual({ platformFeePct: 1.5, platformFee: 3750, sellerNet: 246250 });
    const forBuyer: any = await s.service.get(forSeller.id, 'buyer-1', 'BUYER');
    expect(forBuyer.orderAmount).toBe(250000);
    for (const k of ['sellerSettlement', 'platformFee', 'platformFeePct', 'sellerNet']) expect(forBuyer).not.toHaveProperty(k);
    expect(JSON.stringify(forBuyer)).not.toMatch(/3750|246250/);
    const list: any[] = await s.service.listMine('buyer-1', 'buyer');
    expect(JSON.stringify(list)).not.toMatch(/3750|246250/);
    const forOrder: any[] = await s.service.forOrder('order-1', 'buyer-1', 'BUYER');
    expect(JSON.stringify(forOrder)).not.toMatch(/3750|246250/);
  });

  it('the buyer-facing PDF carries no platform fee text', async () => {
    const s = await setup();
    await s.service.issue('seller-1', 'order-1');
    const raw = Object.values(s.stored)[0].toString('latin1');
    expect(raw).not.toMatch(/Platform fee|Seller net/i);
  });

  it('at most ONE live invoice per order', async () => {
    const s = await setup();
    await s.service.issue('seller-1', 'order-1');
    await expect(s.service.issue('seller-1', 'order-1')).rejects.toThrow(/already has an active invoice/);
    expect(s.db.sellerInvoice.rows).toHaveLength(1);
  });

  it('CONCURRENCY: simultaneous issues create exactly one invoice', async () => {
    const s = await setup();
    const r = await Promise.allSettled([s.service.issue('seller-1', 'order-1'), s.service.issue('seller-1', 'order-1'), s.service.issue('seller-1', 'order-1')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(s.db.sellerInvoice.rows.filter((i: any) => i.status !== 'VOID')).toHaveLength(1);
  });

  it('invoice numbers are unique and sequential across orders', async () => {
    const s = await setup();
    s.db.offer.seed({ id: 'offer-2', productId: 'prod-1', buyerId: 'buyer-1', quantity: 10 });
    s.db.order.seed({ id: 'order-2', offerId: 'offer-2', sellerId: 'seller-1', buyerId: 'buyer-1', status: 'CONFIRMED', totalAmount: 100, platformFeePct: 1.5, platformFee: 1.5, netSellerAmount: 98.5, unitPrice: 10, quantity: 10, paymentTermsSnapshot: { type: 'COD' } });
    const a: any = await s.service.issue('seller-1', 'order-1');
    const b: any = await s.service.issue('seller-1', 'order-2');
    expect(new Set([a.invoiceNumber, b.invoiceNumber]).size).toBe(2);
    expect(b.invoiceNumber).toMatch(/000002$/);
  });

  it('only the seller of the order, an approved account, for a live order', async () => {
    const s = await setup();
    await expect(s.service.issue('buyer-1', 'order-1')).rejects.toThrow(ForbiddenException);
    await expect(s.service.issue('seller-1', 'nope')).rejects.toThrow(NotFoundException);
    s.db.order.rows[0].status = 'CANCELLED';
    await expect(s.service.issue('seller-1', 'order-1')).rejects.toThrow(/cancelled/);
    s.db.order.rows[0].status = 'DISPUTED';
    await expect(s.service.issue('seller-1', 'order-1')).rejects.toThrow(BadRequestException);
    s.db.order.rows[0].status = 'CONFIRMED';
    s.db.user.rows[0].kycStatus = 'INFO_REQUESTED';
    await expect(s.service.issue('seller-1', 'order-1')).rejects.toThrow(ForbiddenException);
  });

  it('notifies the buyer with an invoice deep link and audits the action', async () => {
    const s = await setup();
    const inv: any = await s.service.issue('seller-1', 'order-1');
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'buyer-1', type: 'PAYMENT_DUE',
      data: expect.objectContaining({ route: '/buyer', tab: 'orders', entityType: 'invoice', entityId: inv.id }),
    }));
    expect(s.db.auditLog.rows.map((a: any) => a.action)).toContain('seller_invoice_issued');
  });

  it('due date follows the order terms snapshot and the delivery acknowledgement (D3)', async () => {
    const s = await setup();
    const inv: any = await s.service.issue('seller-1', 'order-1');
    expect(inv.dueDate).toBeNull(); // not acknowledged yet
    const ack = new Date('2026-11-01T00:00:00Z');
    s.db.orderStatusHistory.seed({ orderId: 'order-1', status: 'DELIVERED', createdAt: ack });
    const later: any = await s.service.get(inv.id, 'buyer-1', 'BUYER');
    expect(new Date(later.dueDate).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('the issued invoice keeps the ORIGINAL terms even if the order row were somehow altered afterwards', async () => {
    const s = await setup();
    const inv: any = await s.service.issue('seller-1', 'order-1');
    s.db.order.rows[0].paymentTermsSnapshot = { type: 'FULL_ADVANCE' };
    const again: any = await s.service.get(inv.id, 'seller-1', 'SELLER');
    expect(again.paymentTermsSnapshot).toMatchObject({ type: 'CREDIT', creditDays: 30 });
  });
});

describe('SellerInvoiceService payment flow', () => {
  const issued = async () => { const s = await setup(); const inv: any = await s.service.issue('seller-1', 'order-1'); return { ...s, id: inv.id }; };

  it('ISSUED -> PAYMENT_SUBMITTED (buyer) -> PAYMENT_CONFIRMED (seller), marking the order PAID', async () => {
    const s = await issued();
    await expect(s.service.confirmPayment(s.id, 'seller-1', 'FARMER')).rejects.toThrow(/submitted payment/);
    const sub: any = await s.service.submitPayment(s.id, 'buyer-1', { reference: 'IBFT-12345', note: 'paid via bank' });
    expect(sub).toMatchObject({ status: 'PAYMENT_SUBMITTED', paymentReference: 'IBFT-12345' });
    expect(s.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'seller-1', type: 'PAYMENT_RECEIVED' }));
    const done: any = await s.service.confirmPayment(s.id, 'seller-1', 'FARMER');
    expect(done.status).toBe('PAYMENT_CONFIRMED');
    expect(s.db.order.rows[0].paymentStatus).toBe('PAID');
    expect(s.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', type: 'PAYMENT_RECEIVED' }));
  });

  it('only the buyer submits; only the seller (or admin) confirms', async () => {
    const s = await issued();
    await expect(s.service.submitPayment(s.id, 'seller-1', { reference: 'abc' })).rejects.toThrow(ForbiddenException);
    s.db.user.seed({ id: 'stranger' });
    await expect(s.service.submitPayment(s.id, 'stranger', { reference: 'abc' })).rejects.toThrow(ForbiddenException);
    await s.service.submitPayment(s.id, 'buyer-1', { reference: 'abc' });
    await expect(s.service.confirmPayment(s.id, 'buyer-1', 'BUYER')).rejects.toThrow(ForbiddenException);
    await expect(s.service.confirmPayment(s.id, 'stranger', 'BUYER')).rejects.toThrow(ForbiddenException);
    s.db.user.seed({ id: 'admin-1' });
    await expect(s.service.confirmPayment(s.id, 'admin-1', 'ADMIN')).resolves.toMatchObject({ status: 'PAYMENT_CONFIRMED' });
  });

  it('a payment cannot be submitted twice, or after confirmation / void', async () => {
    const s = await issued();
    await s.service.submitPayment(s.id, 'buyer-1', { reference: 'abc' });
    await expect(s.service.submitPayment(s.id, 'buyer-1', { reference: 'def' })).rejects.toThrow(/open invoice/);
    await s.service.confirmPayment(s.id, 'seller-1', 'FARMER');
    await expect(s.service.submitPayment(s.id, 'buyer-1', { reference: 'def' })).rejects.toThrow(BadRequestException);
    await expect(s.service.confirmPayment(s.id, 'seller-1', 'FARMER')).rejects.toThrow(BadRequestException);
  });

  it('CONCURRENCY: double-clicking confirm confirms once', async () => {
    const s = await issued();
    await s.service.submitPayment(s.id, 'buyer-1', { reference: 'abc' });
    const r = await Promise.allSettled([s.service.confirmPayment(s.id, 'seller-1', 'FARMER'), s.service.confirmPayment(s.id, 'seller-1', 'FARMER')]);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(s.db.sellerInvoice.rows[0].status).toBe('PAYMENT_CONFIRMED');
  });

  it('the seller can send a submitted payment back (not received) and the buyer can resubmit', async () => {
    const s = await issued();
    await s.service.submitPayment(s.id, 'buyer-1', { reference: 'wrong-ref' });
    const back: any = await s.service.rejectPayment(s.id, 'seller-1', 'Nothing arrived with that reference');
    expect(back).toMatchObject({ status: 'ISSUED', paymentRejectedNote: 'Nothing arrived with that reference' });
    expect(s.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', body: expect.stringMatching(/Nothing arrived/) }));
    await expect(s.service.rejectPayment(s.id, 'seller-1', 'again please')).rejects.toThrow(BadRequestException);
    await expect(s.service.submitPayment(s.id, 'buyer-1', { reference: 'right-ref' })).resolves.toMatchObject({ status: 'PAYMENT_SUBMITTED' });
  });

  it('void: seller/admin only, only before confirmation, and it tells the buyer why', async () => {
    const s = await issued();
    await expect(s.service.void(s.id, 'buyer-1', 'BUYER', 'because I said so')).rejects.toThrow(ForbiddenException);
    const v: any = await s.service.void(s.id, 'seller-1', 'FARMER', 'wrong quantity on it');
    expect(v).toMatchObject({ status: 'VOID', voidReason: 'wrong quantity on it' });
    expect(v.downloadUrl).toBeNull();
    expect(s.notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'buyer-1', body: expect.stringMatching(/wrong quantity/) }));
    await expect(s.service.void(s.id, 'seller-1', 'FARMER', 'again again')).rejects.toThrow(/already void/);
  });

  it('a CONFIRMED invoice cannot be voided', async () => {
    const s = await issued();
    await s.service.submitPayment(s.id, 'buyer-1', { reference: 'abc' });
    await s.service.confirmPayment(s.id, 'seller-1', 'FARMER');
    await expect(s.service.void(s.id, 'seller-1', 'FARMER', 'oops wrong one')).rejects.toThrow(/confirmed invoice cannot be voided/);
  });

  it('replace voids the old invoice and issues a NEW number with version+1; still one live invoice', async () => {
    const s = await issued();
    const old = s.db.sellerInvoice.rows[0];
    const fresh: any = await s.service.replace(s.id, 'seller-1', 'wrong unit price');
    expect(fresh.version).toBe(2);
    expect(fresh.replacesId).toBe(old.id);
    expect(fresh.invoiceNumber).not.toBe(old.invoiceNumber);
    expect(old.status).toBe('VOID');
    expect(s.db.sellerInvoice.rows.filter((i: any) => i.status !== 'VOID')).toHaveLength(1);
  });

  it('only participants (or admin) can read an invoice', async () => {
    const s = await issued();
    s.db.user.seed({ id: 'stranger' });
    await expect(s.service.get(s.id, 'stranger', 'FARMER')).rejects.toThrow(ForbiddenException);
    await expect(s.service.get(s.id, 'stranger', 'ADMIN')).resolves.toBeDefined();
    await expect(s.service.forOrder('order-1', 'stranger', 'FARMER')).rejects.toThrow(ForbiddenException);
    await expect(s.service.get('nope', 'buyer-1', 'BUYER')).rejects.toThrow(NotFoundException);
  });

  it('a failed PDF upload at issue time does not fail the invoice: it is regenerated on first view', async () => {
    const s = await setup();
    s.storage.putObject.mockRejectedValueOnce(new Error('bucket down'));
    const inv: any = await s.service.issue('seller-1', 'order-1');
    expect(inv.status).toBe('ISSUED');
    expect(s.storage.putObject).toHaveBeenCalledTimes(2); // failed attempt + lazy retry
    expect(inv.downloadUrl).toMatch(/signed\.example/);
    expect(s.db.sellerInvoice.rows[0].s3Key).toMatch(/^seller-invoices\//);
  });
});
