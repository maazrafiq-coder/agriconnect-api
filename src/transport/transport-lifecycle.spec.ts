import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { makeFakePrisma } from '../offers/__testing__/fake-prisma';
import { TransportLifecycleService } from './transport-lifecycle.service';

const TERMS = { type: 'COD' };

describe('TransportLifecycleService (stateful fake DB)', () => {
  let db: any; let svc: TransportLifecycleService; let notify: jest.Mock; let reqId: string;
  const B = 'buyer-1'; const P = 'prov-1';

  beforeEach(() => {
    db = makeFakePrisma();
    notify = jest.fn().mockResolvedValue(undefined);
    svc = new TransportLifecycleService(db, { notify } as any);
    db.user.seed({ id: B }); db.user.seed({ id: P }); db.user.seed({ id: 'stranger' }); db.user.seed({ id: 'pending', kycStatus: 'PENDING' });
    const r = db.transportRequest.seed({ requesterId: B, providerId: P, pickupCity: 'Lahore', deliveryCity: 'Karachi', requestNumber: 'TRQ-2026-000001', requestSeq: 1 });
    reqId = r.id;
  });

  const quote = async (price = 45000, extra: any = {}) => svc.propose(reqId, P, 'PROVIDER', { price, paymentTerms: TERMS, ...extra } as any);
  const row = () => db.transportRequest.rows.find((r: any) => r.id === reqId);
  const bookIt = async (price = 45000) => { const q: any = await quote(price); await svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true }); };

  describe('quote rounds', () => {
    it('a quote opens round 1, sets QUOTED, mirrors the legacy columns and tells the requester', async () => {
      const out: any = await quote(45000, { note: 'incl. loading' });
      expect(out.currentRound).toMatchObject({ roundNo: 1, proposerRole: 'PROVIDER', price: 45000, status: 'CURRENT' });
      expect(out.status).toBe('QUOTED'); expect(out.turn).toBe('REQUESTER');
      expect(row()).toMatchObject({ quotedPrice: 45000, quoteNote: 'incl. loading', currentRoundId: out.currentRound.id });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: B, data: expect.objectContaining({ route: '/buyer', tab: 'transport', entityId: reqId }) }));
    });

    it('requester counters, provider counters back; every older round is SUPERSEDED, exactly one stays CURRENT', async () => {
      await quote(50000);
      await svc.propose(reqId, B, 'REQUESTER', { price: 42000, paymentTerms: TERMS } as any);
      const out: any = await svc.propose(reqId, P, 'PROVIDER', { price: 46000, paymentTerms: TERMS } as any);
      expect(out.rounds.map((r: any) => [r.roundNo, r.proposerRole, r.status])).toEqual([[1, 'PROVIDER', 'SUPERSEDED'], [2, 'REQUESTER', 'SUPERSEDED'], [3, 'PROVIDER', 'CURRENT']]);
      expect(out.turn).toBe('REQUESTER');
    });

    it('roles are enforced: provider cannot counter, requester cannot quote, strangers are refused', async () => {
      await expect(svc.propose(reqId, P, 'REQUESTER', { price: 1, paymentTerms: TERMS } as any)).rejects.toThrow(ForbiddenException);
      await expect(svc.propose(reqId, B, 'PROVIDER', { price: 1, paymentTerms: TERMS } as any)).rejects.toThrow(ForbiddenException);
      await expect(svc.propose(reqId, 'stranger', 'PROVIDER', { price: 1, paymentTerms: TERMS } as any)).rejects.toThrow(ForbiddenException);
      await expect(svc.propose(reqId, B, 'REQUESTER', { price: 1, paymentTerms: TERMS } as any)).rejects.toThrow(/no quote to counter/);
    });

    it('an unapproved account cannot negotiate', async () => {
      db.transportRequest.rows[0].providerId = 'pending';
      await expect(svc.propose(reqId, 'pending', 'PROVIDER', { price: 1, paymentTerms: TERMS } as any)).rejects.toThrow(/approved/);
    });

    it('a stale roundId is a 409 - nobody answers a price that has moved', async () => {
      const q: any = await quote(50000);
      await svc.propose(reqId, B, 'REQUESTER', { price: 40000, paymentTerms: TERMS } as any);
      await expect(svc.propose(reqId, P, 'PROVIDER', { price: 45000, paymentTerms: TERMS, roundId: q.currentRound.id } as any)).rejects.toThrow(ConflictException);
    });

    it('a retried send with the same Idempotency-Key is a replay, not a second round', async () => {
      await quote(45000, { clientRequestId: 'k1' });
      notify.mockClear();
      await quote(45000, { clientRequestId: 'k1' });
      expect(db.transportQuoteRound.rows).toHaveLength(1);
      expect(notify).not.toHaveBeenCalled();
    });

    it('no quotes once the shipment is booked', async () => {
      await bookIt();
      await expect(quote(1)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Phase 4 - charges, payment terms, transport order number', () => {
    it('total = base + extra charges, computed server-side; the legacy quotedPrice mirrors the TOTAL', async () => {
      const out: any = await quote(40000, { additionalCharges: [{ label: 'Loading', amount: 2500 }, { label: 'Toll', amount: 1500.5 }], totalPrice: 1 });
      expect(out.currentRound).toMatchObject({ price: 40000, totalPrice: 44000.5 });
      expect(out.currentRound.additionalCharges).toHaveLength(2);
      expect(row().quotedPrice).toBe(44000.5);
    });

    it('payment terms are mandatory on a quote and are validated with the marketplace rules', async () => {
      await expect(svc.propose(reqId, P, 'PROVIDER', { price: 1000 } as any)).rejects.toThrow(/Payment terms are required/);
      await expect(quote(1000, { paymentTerms: { type: 'CREDIT' } })).rejects.toThrow(/Credit period/);
      await expect(quote(1000, { paymentTerms: { type: 'OTHER', description: 'x' } })).rejects.toThrow(/Describe/);
    });

    it('arrival cannot precede pickup; validHours sets the expiry', async () => {
      await expect(quote(1000, { estimatedPickup: '2026-11-05', estimatedArrival: '2026-11-04' })).rejects.toThrow(/before the pickup/);
      const out: any = await quote(1000, { validHours: 24 });
      const hrs = (new Date(out.currentRound.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hrs).toBeGreaterThan(23); expect(hrs).toBeLessThan(25);
    });

    it('a counter carries terms, charges, vehicle and conditions forward unless re-sent', async () => {
      await quote(40000, { additionalCharges: [{ label: 'Loading', amount: 2000 }], vehicleDetails: '20t truck', conditions: 'Unload within 6h', paymentTerms: { type: 'CREDIT', creditDays: 30 } });
      const c: any = await svc.propose(reqId, B, 'REQUESTER', { price: 38000 } as any);
      expect(c.currentRound).toMatchObject({ roundNo: 2, totalPrice: 40000, vehicleDetails: '20t truck', conditions: 'Unload within 6h' });
      expect(c.currentRound.paymentTerms).toMatchObject({ type: 'CREDIT', creditDays: 30 });
    });

    it('accepting needs an explicit acceptTerms; then TRO-… is issued, distinct from the TRQ ref, with an immutable-by-design snapshot', async () => {
      const q: any = await quote(40000, { additionalCharges: [{ label: 'Loading', amount: 2000 }], conditions: 'Unload within 6h' });
      await expect(svc.accept(reqId, B, { roundId: q.currentRound.id } as any)).rejects.toThrow(/review and accept/);
      expect(row().status).toBe('QUOTED');
      const out: any = await svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true });
      expect(out.transportOrderRef).toMatch(/^TRO-\d{4}-\d{6}$/);
      expect(out.requestRef).toBe('TRQ-2026-000001');
      expect(out.transportOrderRef).not.toBe(out.requestRef);
      expect(row()).toMatchObject({
        agreedPrice: 42000, agreedConditions: 'Unload within 6h', termsAcceptedById: B,
        paymentTermsSnapshot: { type: 'COD' },
      });
      expect(row().termsAcceptedAt).toBeInstanceOf(Date);
      expect(row().agreedCharges).toEqual([{ label: 'Loading', amount: 2000 }]);
    });

    it('two bookings get two different TRO numbers', async () => {
      await bookIt();
      const r2 = db.transportRequest.seed({ requesterId: B, providerId: P, pickupCity: 'A', deliveryCity: 'B', requestNumber: 'TRQ-2026-000002', requestSeq: 2 });
      const q: any = await svc.propose(r2.id, P, 'PROVIDER', { price: 10, paymentTerms: TERMS } as any);
      const out: any = await svc.accept(r2.id, B, { roundId: q.currentRound.id, acceptTerms: true });
      expect(out.transportOrderRef).not.toBe(row().orderNumber);
      expect(row().orderNumber).toMatch(/^TRO-/);
    });

    it('DELIVERED needs the receiver name; delivery evidence is stored', async () => {
      await bookIt();
      await svc.updateTracking(reqId, P, { status: 'PICKED_UP', driverName: 'Ali Khan', driverPhone: '+923001234567', vehiclePlate: 'LEA-1234' } as any);
      await svc.updateTracking(reqId, P, { status: 'IN_TRANSIT' } as any);
      await expect(svc.updateTracking(reqId, P, { status: 'DELIVERED' } as any)).rejects.toThrow(/who received/);
      await svc.updateTracking(reqId, P, { status: 'DELIVERED', receiverName: 'Store Keeper', deliveryNote: 'Gate pass 55', deliveredQuantityTons: 19.5 } as any);
      expect(row()).toMatchObject({ status: 'DELIVERED', deliveryReceiverName: 'Store Keeper', deliveryNote: 'Gate pass 55', deliveredQuantityTons: 19.5 });
    });
  });

  describe('accept', () => {
    it('requester accepts the quote: BOOKED at exactly that round price, round ACCEPTED', async () => {
      const q: any = await quote(45000);
      const out: any = await svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true });
      expect(out.status).toBe('BOOKED');
      expect(row()).toMatchObject({ agreedPrice: 45000, agreedRoundId: q.currentRound.id });
      expect(db.transportQuoteRound.rows[0].status).toBe('ACCEPTED');
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: P }));
    });

    it('provider can accept the requester\'s counter-offer; nobody can accept their own proposal', async () => {
      await quote(50000);
      const c: any = await svc.propose(reqId, B, 'REQUESTER', { price: 41000, paymentTerms: TERMS } as any);
      await expect(svc.accept(reqId, B, { roundId: c.currentRound.id, acceptTerms: true })).rejects.toThrow(/your own proposal/);
      await svc.accept(reqId, P, { roundId: c.currentRound.id, acceptTerms: true });
      expect(row()).toMatchObject({ status: 'BOOKED', agreedPrice: 41000 });
    });

    it('requires the roundId and rejects a stale one', async () => {
      const q: any = await quote(50000);
      await expect(svc.accept(reqId, B, {})).rejects.toThrow(/roundId/);
      await svc.propose(reqId, P, 'PROVIDER', { price: 48000, paymentTerms: TERMS } as any);
      await expect(svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true })).rejects.toThrow(ConflictException);
      expect(row().status).toBe('QUOTED');
    });

    it('double accept is safe: exactly one ACCEPTED round and one booking', async () => {
      const q: any = await quote(30000);
      const res = await Promise.allSettled([svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true }), svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true })]);
      expect(res.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(db.transportQuoteRound.rows.filter((r: any) => r.status === 'ACCEPTED')).toHaveLength(1);
      expect(row()).toMatchObject({ status: 'BOOKED', agreedPrice: 30000 });
      // replay after the fact is idempotent
      await expect(svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true })).resolves.toBeDefined();
    });

    it('an expired quote cannot be accepted and the request returns to awaiting-quote', async () => {
      const q: any = await quote(30000);
      db.transportQuoteRound.rows[0].expiresAt = new Date(Date.now() - 1000);
      await expect(svc.accept(reqId, B, { roundId: q.currentRound.id, acceptTerms: true })).rejects.toThrow(BadRequestException);
      expect(row().status).toBe('REQUESTED');
      expect(db.transportQuoteRound.rows[0].status).toBe('EXPIRED');
    });
  });

  describe('reject / decline / cancel', () => {
    it('requester rejects a quote with a reason: round DECLINED, back to REQUESTED, provider told', async () => {
      await quote(50000);
      await expect(svc.rejectRound(reqId, B, 'no')).rejects.toThrow(/reason/);
      await svc.rejectRound(reqId, B, 'Too expensive for this route');
      expect(db.transportQuoteRound.rows[0].status).toBe('DECLINED');
      expect(row()).toMatchObject({ status: 'REQUESTED', quotedPrice: null, currentRoundId: null });
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: P }));
      await expect(svc.rejectRound(reqId, B, 'again please')).rejects.toThrow(/no open quote/);
    });

    it('you cannot reject your own proposal', async () => {
      await quote(50000);
      await expect(svc.rejectRound(reqId, P, 'changed my mind')).rejects.toThrow(/your own proposal/);
    });

    it('provider decline unassigns the request and closes the round', async () => {
      await quote(50000);
      await svc.decline(reqId, P, 'No trucks that week');
      expect(row()).toMatchObject({ providerId: null, status: 'REQUESTED' });
      expect(db.transportQuoteRound.rows[0].status).toBe('DECLINED');
    });

    it('requester can cancel until pickup, not after', async () => {
      await bookIt();
      await svc.cancel(reqId, B, 'plans changed');
      expect(row().status).toBe('CANCELLED');
      row().status = 'IN_TRANSIT';
      await expect(svc.cancel(reqId, B)).rejects.toThrow(/already been picked up/);
      await expect(svc.cancel(reqId, 'stranger')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('driver details + tracking', () => {
    beforeEach(async () => { await bookIt(); });

    it('cannot mark PICKED_UP without driver name and phone; succeeds once they are given', async () => {
      await expect(svc.updateTracking(reqId, P, { status: 'PICKED_UP' } as any)).rejects.toThrow(/driver/i);
      await expect(svc.updateTracking(reqId, P, { status: 'PICKED_UP', driverName: 'Ali Khan' } as any)).rejects.toThrow(/driver/i);
      await svc.updateTracking(reqId, P, { status: 'PICKED_UP', driverName: 'Ali Khan', driverPhone: '+923001234567', vehicleRegNo: 'lea-1234' } as any);
      expect(row()).toMatchObject({ status: 'PICKED_UP', driverName: 'Ali Khan', driverPhone: '+923001234567', vehicleRegNo: 'LEA-1234' });
      expect(row().pickedUpAt).toBeInstanceOf(Date);
    });

    it('driver details can be set while BOOKED, and the notification never contains the phone number', async () => {
      notify.mockClear();
      await svc.updateTracking(reqId, P, { driverName: 'Ali Khan', driverPhone: '+923001234567' } as any);
      expect(row().status).toBe('BOOKED');
      const sent = JSON.stringify(notify.mock.calls);
      expect(sent).toContain('Ali Khan');
      expect(sent).not.toContain('923001234567');
    });

    it('walks BOOKED -> PICKED_UP -> IN_TRANSIT -> DELIVERED; no skipping, no backwards, no tracking after delivery', async () => {
      await expect(svc.updateTracking(reqId, P, { status: 'DELIVERED', receiverName: 'Store Keeper' } as any)).rejects.toThrow(/can't move/);
      await svc.updateTracking(reqId, P, { status: 'PICKED_UP', driverName: 'Ali', driverPhone: '03001234567' } as any);
      await svc.updateTracking(reqId, P, { status: 'IN_TRANSIT' } as any);
      await expect(svc.updateTracking(reqId, P, { status: 'PICKED_UP' } as any)).rejects.toThrow(/can't move/);
      await expect(svc.updateTracking(reqId, P, { status: 'DELIVERED' } as any)).rejects.toThrow(/who received/);
      await svc.updateTracking(reqId, P, { status: 'DELIVERED', receiverName: 'Store Keeper', deliveryNote: 'Signed gate pass', deliveredQuantityTons: 19.8 } as any);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: B, body: expect.stringMatching(/acknowledge/i) }));
      await expect(svc.updateTracking(reqId, P, { currentLocation: 'x' } as any)).rejects.toThrow(/can't be updated/);
    });

    it('only the assigned provider can update tracking', async () => {
      await expect(svc.updateTracking(reqId, 'stranger', { status: 'PICKED_UP' } as any)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('delivery acknowledgement', () => {
    const deliver = () => { Object.assign(row(), { status: 'DELIVERED', deliveredAt: new Date() }); };

    it('only the requester can acknowledge, only after DELIVERED; DELIVERED -> COMPLETED with a timestamp', async () => {
      await bookIt();
      await expect(svc.acknowledge(reqId, B)).rejects.toThrow(/marked the shipment delivered/);
      deliver();
      await expect(svc.acknowledge(reqId, P)).rejects.toThrow(ForbiddenException);
      const out: any = await svc.acknowledge(reqId, B, 'all bags counted');
      expect(out.status).toBe('COMPLETED');
      expect(row()).toMatchObject({ acknowledgedById: B, acknowledgementNote: 'all bags counted' });
      expect(row().acknowledgedAt).toBeInstanceOf(Date);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: P }));
      await expect(svc.acknowledge(reqId, B)).resolves.toBeDefined(); // idempotent
    });

    it('cannot be acknowledged while disputed', async () => {
      await bookIt(); deliver(); row().status = 'DISPUTED';
      await expect(svc.acknowledge(reqId, B)).rejects.toThrow(/dispute/);
    });
  });

  describe('D4 - driver privacy', () => {
    beforeEach(async () => {
      await bookIt();
      await svc.updateTracking(reqId, P, { status: 'PICKED_UP', driverName: 'Ali Khan', driverPhone: '+923001234567', vehicleRegNo: 'LEA-1234', currentLocation: 'Multan' } as any);
    });

    it('the PUBLIC tracking view has a masked driver name and no phone, plate, price or ids of people', async () => {
      const pub: any = await svc.track(reqId);
      expect(pub).toMatchObject({ requestRef: 'TRQ-2026-000001', status: 'PICKED_UP', currentLocation: 'Multan', driverName: 'Ali K.' });
      const text = JSON.stringify(pub);
      for (const secret of ['923001234567', 'LEA-1234', 'Ali Khan', 'agreedPrice', 'quotedPrice', 'driverPhone', 'requesterId', 'providerId']) expect(text).not.toContain(secret);
    });

    it('the requester and the provider get the full driver details; strangers get 403; admin may read', async () => {
      for (const who of [B, P]) {
        const full: any = await svc.getOne(reqId, who, 'USER');
        expect(full).toMatchObject({ driverName: 'Ali Khan', driverPhone: '+923001234567', vehicleRegNo: 'LEA-1234', agreedPrice: 45000 });
      }
      await expect(svc.getOne(reqId, 'stranger', 'USER')).rejects.toThrow(ForbiddenException);
      await expect(svc.getOne(reqId, 'stranger', 'ADMIN')).resolves.toMatchObject({ driverPhone: '+923001234567' });
    });

    it('a dispute or acknowledgement is invisible on the public page (coarse status)', async () => {
      Object.assign(row(), { status: 'DISPUTED', statusBeforeDispute: 'DELIVERED' });
      expect((await svc.track(reqId) as any).status).toBe('DELIVERED');
      row().status = 'COMPLETED';
      expect((await svc.track(reqId) as any).status).toBe('DELIVERED');
    });
  });
});
