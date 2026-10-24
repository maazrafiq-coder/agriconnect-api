import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { makeFakePrisma } from '../offers/__testing__/fake-prisma';
import { TransportInvoiceService } from './transport-invoice.service';
import { TransportDisputeService } from './transport-dispute.service';
import { TransportLifecycleService } from './transport-lifecycle.service';

const B = 'buyer-1'; const P = 'prov-1';

function setup() {
  const db = makeFakePrisma();
  const notify = jest.fn().mockResolvedValue(undefined);
  const storage: any = { putObject: jest.fn().mockResolvedValue(undefined), getPresignedUrl: jest.fn().mockResolvedValue('https://signed/x.pdf') };
  [B, P, 'stranger', 'admin-1'].forEach((id) => db.user.seed({ id }));
  const req = db.transportRequest.seed({
    requesterId: B, providerId: P, pickupCity: 'Lahore', deliveryCity: 'Karachi', requestNumber: 'TRQ-2026-000001', requestSeq: 1,
    status: 'DELIVERED', agreedPrice: 45000, cargoDescription: 'Rice 20t',
    orderNumber: 'TRO-2026-000007', orderConfirmedAt: new Date('2026-10-01'), deliveredAt: new Date('2026-10-05'),
    paymentTermsSnapshot: { type: 'CREDIT', creditDays: 7, creditStart: 'INVOICE_DATE' },
  });
  return {
    db, notify, req,
    inv: new TransportInvoiceService(db, storage, { notify } as any),
    dsp: new TransportDisputeService(db, { notify } as any),
    life: new TransportLifecycleService(db, { notify } as any),
  };
}

describe('TransportInvoiceService', () => {
  it('due date follows the agreed terms: COD is due on delivery, credit-from-acknowledgement stays open-ended until acknowledged', async () => {
    const a = setup();
    a.req.paymentTermsSnapshot = { type: 'COD' };
    const cod: any = await a.inv.issue(P, a.req.id);
    expect(new Date(cod.dueDate).toISOString()).toBe(new Date('2026-10-05').toISOString());
    const b = setup();
    b.req.paymentTermsSnapshot = { type: 'CREDIT', creditDays: 30, creditStart: 'DELIVERY_ACK' };
    const open: any = await b.inv.issue(P, b.req.id);
    expect(open.dueDate).toBeNull();
    const c = setup();
    c.req.paymentTermsSnapshot = { type: 'CREDIT', creditDays: 30, creditStart: 'DELIVERY_ACK' };
    c.req.acknowledgedAt = new Date('2026-10-06');
    const acked: any = await c.inv.issue(P, c.req.id);
    expect(new Date(acked.dueDate).toISOString()).toBe(new Date('2026-11-05').toISOString());
  });

  it('issues TINV-… for exactly the agreed price, due per the agreed terms (7 days from invoice), carries the TRO number, buyer notified; no fee fields exist', async () => {
    const { inv, req, notify } = setup();
    const out: any = await inv.issue(P, req.id);
    expect(out).toMatchObject({ status: 'ISSUED', amount: 45000, version: 1, requestRef: 'TRQ-2026-000001', downloadUrl: 'https://signed/x.pdf' });
    expect(out.invoiceNumber).toMatch(/^TINV-\d{4}-\d{6}$/);
    expect(Math.round((new Date(out.dueDate).getTime() - new Date(out.issuedAt).getTime()) / 86_400_000)).toBe(7);
    expect(out.orderNumber).toBe('TRO-2026-000007');
    expect(Object.keys(out).filter((k) => /fee|net|settlement/i.test(k))).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: B, type: 'PAYMENT_DUE' }));
  });

  it('only the shipment\'s transporter can issue, and only after delivery', async () => {
    const { inv, req, db } = setup();
    await expect(inv.issue('stranger', req.id)).rejects.toThrow(ForbiddenException);
    await expect(inv.issue(B, req.id)).rejects.toThrow(ForbiddenException);
    db.transportRequest.rows[0].status = 'IN_TRANSIT';
    await expect(inv.issue(P, req.id)).rejects.toThrow(/after delivery/);
  });

  it('one live invoice per shipment; void then replace gives a new number and version 2', async () => {
    const { inv, req } = setup();
    const first: any = await inv.issue(P, req.id);
    await expect(inv.issue(P, req.id)).rejects.toThrow(/already has an active invoice/);
    const second: any = await inv.replace(first.id, P, 'wrong cargo description');
    expect(second.version).toBe(2);
    expect(second.invoiceNumber).not.toBe(first.invoiceNumber);
    expect((await inv.get(first.id, P, 'USER') as any).status).toBe('VOID');
    expect((await inv.forRequest(req.id, B, 'USER')).filter((i: any) => i.status !== 'VOID')).toHaveLength(1);
  });

  it('payment flow: requester submits -> transporter confirms; reject sends it back to ISSUED', async () => {
    const { inv, req } = setup();
    const i: any = await inv.issue(P, req.id);
    await expect(inv.submitPayment(i.id, P, { reference: 'TX1' } as any)).rejects.toThrow(ForbiddenException);
    await expect(inv.confirmPayment(i.id, P, 'USER')).rejects.toThrow(/submitted payment/);
    await inv.submitPayment(i.id, B, { reference: 'BANK-123' } as any);
    const back: any = await inv.rejectPayment(i.id, P, 'Amount does not match');
    expect(back).toMatchObject({ status: 'ISSUED', paymentRejectedNote: 'Amount does not match' });
    await inv.submitPayment(i.id, B, { reference: 'BANK-124' } as any);
    await expect(inv.confirmPayment(i.id, B, 'USER')).rejects.toThrow(ForbiddenException);
    expect(await inv.confirmPayment(i.id, P, 'USER')).toMatchObject({ status: 'PAYMENT_CONFIRMED' });
    await expect(inv.void(i.id, P, 'USER', 'oops wrong')).rejects.toThrow(/confirmed invoice cannot be voided/);
  });

  it('the requester cannot submit payment while the shipment is disputed', async () => {
    const { inv, req, db } = setup();
    const i: any = await inv.issue(P, req.id);
    db.transportRequest.rows[0].status = 'DISPUTED';
    await expect(inv.submitPayment(i.id, B, { reference: 'BANK-1' } as any)).rejects.toThrow(/under dispute/);
  });

  it('strangers cannot read an invoice; admins can', async () => {
    const { inv, req } = setup();
    const i: any = await inv.issue(P, req.id);
    await expect(inv.get(i.id, 'stranger', 'USER')).rejects.toThrow(ForbiddenException);
    await expect(inv.get(i.id, 'admin-1', 'ADMIN')).resolves.toBeDefined();
  });
});

describe('TransportDisputeService', () => {
  const raise = (s: ReturnType<typeof setup>, by = B, extra: any = {}) =>
    s.dsp.raise(s.req.id, by, { category: 'DAMAGED_CARGO', description: 'Twenty bags arrived torn', ...extra } as any);

  it('raising a dispute freezes the shipment (DISPUTED) and remembers the previous status; other side notified', async () => {
    const s = setup();
    const d: any = await raise(s, B, { claimAmount: 12000 });
    expect(d).toMatchObject({ status: 'OPEN', raisedByRole: 'REQUESTER', awaiting: 'PROVIDER', claimAmount: 12000 });
    expect(d.disputeNumber).toMatch(/^TDS-\d{4}-\d{6}$/);
    expect(s.db.transportRequest.rows[0]).toMatchObject({ status: 'DISPUTED', statusBeforeDispute: 'DELIVERED' });
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: P }));
  });

  it('only parties can raise, only on delivered shipments, only one open at a time', async () => {
    const s = setup();
    await expect(raise(s, 'stranger')).rejects.toThrow(ForbiddenException);
    s.db.transportRequest.rows[0].status = 'IN_TRANSIT';
    await expect(raise(s)).rejects.toThrow(/delivered/);
    s.db.transportRequest.rows[0].status = 'DELIVERED';
    await raise(s);
    await expect(raise(s, P)).rejects.toThrow(/already has an open dispute/);
  });

  it('a COMPLETED shipment can be disputed within 7 days of acknowledgement, not after', async () => {
    const s = setup();
    Object.assign(s.db.transportRequest.rows[0], { status: 'COMPLETED', acknowledgedAt: new Date() });
    await raise(s);
    expect(s.db.transportRequest.rows[0].statusBeforeDispute).toBe('COMPLETED');
    const t = setup();
    Object.assign(t.db.transportRequest.rows[0], { status: 'COMPLETED', acknowledgedAt: new Date(Date.now() - 8 * 86_400_000) });
    await expect(raise(t)).rejects.toThrow(/window/);
  });

  it('a retried raise with the same Idempotency-Key returns the same dispute', async () => {
    const s = setup();
    const a: any = await raise(s, B, { clientRequestId: 'k1' });
    const b: any = await raise(s, B, { clientRequestId: 'k1' });
    expect(b.id).toBe(a.id);
    expect(s.db.transportDispute.rows).toHaveLength(1);
  });

  it('the OTHER party responds (not the raiser); withdrawing restores the earlier status', async () => {
    const s = setup();
    const d: any = await raise(s);
    await expect(s.dsp.respond(d.id, B, 'I am right')).rejects.toThrow(ForbiddenException);
    const r: any = await s.dsp.respond(d.id, P, 'Bags were sealed at pickup');
    expect(r).toMatchObject({ status: 'RESPONDED', awaiting: 'ADMIN' });
    await expect(s.dsp.withdraw(d.id, P)).rejects.toThrow(ForbiddenException);
    await s.dsp.withdraw(d.id, B);
    expect(s.db.transportRequest.rows[0]).toMatchObject({ status: 'DELIVERED', statusBeforeDispute: null });
    await expect(s.dsp.withdraw(d.id, B)).rejects.toThrow(/already closed/);
  });

  it('admin resolution closes it, unfreezes the shipment, notifies both parties; then the requester can acknowledge', async () => {
    const s = setup();
    const d: any = await raise(s);
    s.notify.mockClear();
    const out: any = await s.dsp.resolve(d.id, 'admin-1', { outcome: 'SETTLED', note: 'Provider credits 5000' } as any);
    expect(out).toMatchObject({ status: 'RESOLVED', resolutionOutcome: 'SETTLED' });
    expect(s.notify.mock.calls.map((c: any) => c[0].userId).sort()).toEqual([B, P].sort());
    expect(s.db.transportRequest.rows[0].status).toBe('DELIVERED');
    expect((await s.life.acknowledge(s.req.id, B) as any).status).toBe('COMPLETED');
  });

  it('visibility: strangers get 403, admin queue lists open disputes first', async () => {
    const s = setup();
    const d: any = await raise(s);
    await expect(s.dsp.get(d.id, 'stranger', 'USER')).rejects.toThrow(ForbiddenException);
    await expect(s.dsp.get(d.id, P, 'USER')).resolves.toMatchObject({ viewer: 'PROVIDER' });
    expect(await s.dsp.adminList()).toHaveLength(1);
  });
});
