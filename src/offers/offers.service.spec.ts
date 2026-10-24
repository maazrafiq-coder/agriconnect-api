import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OffersService, LEGACY_TERMS } from './offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { makeFakePrisma } from './__testing__/fake-prisma';

// The most money-critical path in the app. These specs run against a STATEFUL
// in-memory double (see __testing__/fake-prisma.ts) so they assert outcomes -
// how many orders exist, which round is CURRENT - not just which mocks fired.
const COD = { type: 'COD' };
const CREDIT30 = { type: 'CREDIT', creditDays: 30 };

async function setup() {
  const db = makeFakePrisma();
  const notify = jest.fn().mockResolvedValue(undefined);
  const mod = await Test.createTestingModule({
    providers: [
      OffersService,
      { provide: PrismaService, useValue: db },
      { provide: NotificationsService, useValue: { notify, notifyMany: jest.fn() } },
      { provide: SettingsService, useValue: { getPlatformFeePct: jest.fn().mockResolvedValue(1.5) } },
    ],
  }).compile();
  const service = mod.get(OffersService);
  const seller = db.user.seed({ id: 'seller-1' });
  const buyer = db.user.seed({ id: 'buyer-1' });
  const product = db.product.seed({ id: 'prod-1', sellerId: seller.id, quantity: 500, minOrderQty: 10, unit: 'kg', paymentTerms: COD });
  return { db, service, notify, seller, buyer, product };
}

const open = async (s: any, over: any = {}) =>
  s.service.create('buyer-1', { productId: 'prod-1', offeredPrice: 100, quantity: 100, acceptTerms: true, ...over });

describe('OffersService.create (round 1)', () => {
  it('creates the offer and its first CURRENT round, defaulting to the listing terms', async () => {
    const s = await setup();
    const offer: any = await open(s);
    expect(s.db.offerRound.rows).toHaveLength(1);
    expect(s.db.offerRound.rows[0]).toMatchObject({ roundNo: 1, proposerRole: 'BUYER', status: 'CURRENT', paymentTerms: COD, price: 100, quantity: 100 });
    expect(offer.currentRoundId).toBe(s.db.offerRound.rows[0].id);
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'seller-1', type: 'OFFER_RECEIVED' }));
  });

  it('requires the buyer to explicitly accept the terms', async () => {
    const s = await setup();
    await expect(open(s, { acceptTerms: false })).rejects.toThrow(/accept the payment terms/);
    await expect(open(s, { acceptTerms: undefined })).rejects.toThrow(BadRequestException);
    expect(s.db.offer.rows).toHaveLength(0);
  });

  it('needs terms from somewhere: listing default or the buyer', async () => {
    const s = await setup();
    s.db.product.rows[0].paymentTerms = null;
    await expect(open(s)).rejects.toThrow(/Choose payment terms/);
    await expect(open(s, { paymentTerms: CREDIT30 })).resolves.toBeDefined();
    expect(s.db.offerRound.rows[0].paymentTerms).toMatchObject({ type: 'CREDIT', creditDays: 30, creditStart: 'DELIVERY_ACK' });
  });

  it('rejects invalid terms', async () => {
    const s = await setup();
    await expect(open(s, { paymentTerms: { type: 'CREDIT', creditDays: 400 } })).rejects.toThrow(/between 1 and 365/);
  });

  it('blocks non-approved buyers, own listings, bad quantities and unavailable listings', async () => {
    const s = await setup();
    s.db.user.rows[1].kycStatus = 'INFO_REQUESTED';
    await expect(open(s)).rejects.toThrow(ForbiddenException);
    s.db.user.rows[1].kycStatus = 'APPROVED';
    await expect(s.service.create('seller-1', { productId: 'prod-1', offeredPrice: 1, quantity: 20, acceptTerms: true })).rejects.toThrow(/own product/);
    await expect(open(s, { quantity: 5 })).rejects.toThrow(/Minimum order/);
    await expect(open(s, { quantity: 501 })).rejects.toThrow(/Only 500/);
    s.db.product.rows[0].status = 'PAUSED';
    await expect(open(s)).rejects.toThrow(/not available/);
  });

  it('replays safely with the same Idempotency-Key', async () => {
    const s = await setup();
    const a: any = await open(s, { clientRequestId: 'k1' });
    const b: any = await open(s, { clientRequestId: 'k1' });
    expect(b.id).toBe(a.id);
    expect(s.db.offer.rows).toHaveLength(1);
  });
});

describe('negotiation rounds', () => {
  it('seller counter supersedes round 1 and keeps exactly one CURRENT round; legacy columns mirror it', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.counter(o.id, 'seller-1', { counterPrice: 120, counterMessage: 'best I can do' });
    const rounds = s.db.offerRound.rows.sort((a: any, b: any) => a.roundNo - b.roundNo);
    expect(rounds.map((r: any) => r.status)).toEqual(['SUPERSEDED', 'CURRENT']);
    expect(rounds[0].supersededById).toBe(rounds[1].id);
    expect(rounds[1]).toMatchObject({ proposerRole: 'SELLER', price: 120, paymentTerms: COD });
    expect(s.db.offer.rows[0]).toMatchObject({ status: 'COUNTERED', counterPrice: 120, counterMessage: 'best I can do', currentRoundId: rounds[1].id });
  });

  it('supports many rounds: buyer counters back, seller counters again, with terms changing', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.propose(o.id, 'seller-1', { price: 130, paymentTerms: { type: 'FULL_ADVANCE' } });
    await s.service.propose(o.id, 'buyer-1', { price: 110, paymentTerms: CREDIT30, message: 'credit please' });
    await s.service.propose(o.id, 'seller-1', { price: 115 });
    const rounds = s.db.offerRound.rows.sort((a: any, b: any) => a.roundNo - b.roundNo);
    expect(rounds.map((r: any) => `${r.roundNo}${r.proposerRole[0]}:${r.status}`)).toEqual(['1B:SUPERSEDED', '2S:SUPERSEDED', '3B:SUPERSEDED', '4S:CURRENT']);
    expect(rounds[3].paymentTerms).toMatchObject({ type: 'CREDIT', creditDays: 30 }); // carried forward from round 3
    expect(s.db.offerRound.rows.filter((r: any) => r.status === 'CURRENT')).toHaveLength(1);
    // buyer counter-back resets the legacy counter columns
    expect(s.db.offer.rows[0]).toMatchObject({ status: 'COUNTERED', counterPrice: 115, offeredPrice: 110 });
  });

  it('you cannot counter your own proposal', async () => {
    const s = await setup();
    const o: any = await open(s);
    await expect(s.service.propose(o.id, 'buyer-1', { price: 90 })).rejects.toThrow(/already have a proposal/);
    await s.service.propose(o.id, 'seller-1', { price: 120 });
    await expect(s.service.propose(o.id, 'seller-1', { price: 125 })).rejects.toThrow(/already have a proposal/);
  });

  it('strangers cannot negotiate; the legacy seller counter still requires a PENDING offer', async () => {
    const s = await setup();
    s.db.user.seed({ id: 'stranger' });
    const o: any = await open(s);
    await expect(s.service.propose(o.id, 'stranger', { price: 1 })).rejects.toThrow(ForbiddenException);
    await s.service.counter(o.id, 'seller-1', { counterPrice: 120 });
    await expect(s.service.counter(o.id, 'seller-1', { counterPrice: 125 })).rejects.toThrow(/Can only counter pending/);
  });

  it('a stale roundId is a 409 (the other party changed the offer while you were reviewing it)', async () => {
    const s = await setup();
    const o: any = await open(s);
    const stale = s.db.offerRound.rows[0].id;
    await s.service.propose(o.id, 'seller-1', { price: 120 });
    await expect(s.service.propose(o.id, 'buyer-1', { price: 100, roundId: stale })).rejects.toThrow(ConflictException);
  });

  it('validates quantity on counters and re-checks terms', async () => {
    const s = await setup();
    const o: any = await open(s);
    await expect(s.service.propose(o.id, 'seller-1', { price: 120, quantity: 9999 })).rejects.toThrow(/Only 500/);
    await expect(s.service.propose(o.id, 'seller-1', { price: 120, paymentTerms: { type: 'PARTIAL_ADVANCE' } })).rejects.toThrow(BadRequestException);
    expect(s.db.offerRound.rows).toHaveLength(1); // nothing changed
  });

  it('an idempotent replay of the same counter does not add a round', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.propose(o.id, 'seller-1', { price: 120, clientRequestId: 'c1' });
    // retry of the same intent: the round already exists, so it is not duplicated
    await expect(s.service.propose(o.id, 'seller-1', { price: 120, clientRequestId: 'c1' })).rejects.toBeDefined();
    expect(s.db.offerRound.rows).toHaveLength(2);
  });

  it('expired offers cannot be countered; rounds and offer are marked EXPIRED', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.db.offer.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(s.service.propose(o.id, 'seller-1', { price: 120 })).rejects.toThrow('This offer has expired');
    expect(s.db.offer.rows[0].status).toBe('EXPIRED');
    expect(s.db.offerRound.rows[0].status).toBe('EXPIRED');
  });

  it('decline / withdraw close the offer and the current round', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.reject(o.id, 'seller-1', 'too low');
    expect(s.db.offer.rows[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'too low' });
    expect(s.db.offerRound.rows[0].status).toBe('DECLINED');

    const o2: any = await open(s);
    await s.service.withdraw(o2.id, 'buyer-1');
    expect(s.db.offerRound.rows.find((r: any) => r.offerId === o2.id).status).toBe('WITHDRAWN');
    await expect(s.service.withdraw(o2.id, 'buyer-1')).rejects.toThrow(BadRequestException);
    await expect(s.service.reject(o2.id, 'seller-1')).rejects.toThrow(BadRequestException);
  });

  it('declining a counter that the buyer received marks that round DECLINED; the seller withdrawing their own is WITHDRAWN', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.counter(o.id, 'seller-1', { counterPrice: 120 });
    await s.service.withdraw(o.id, 'buyer-1');
    expect(s.db.offerRound.rows.find((r: any) => r.roundNo === 2).status).toBe('DECLINED');
    const o2: any = await open(s);
    await s.service.counter(o2.id, 'seller-1', { counterPrice: 120 });
    await s.service.reject(o2.id, 'seller-1');
    expect(s.db.offerRound.rows.find((r: any) => r.offerId === o2.id && r.roundNo === 2).status).toBe('WITHDRAWN');
  });

  it('only the two parties can read the timeline', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.counter(o.id, 'seller-1', { counterPrice: 120 });
    const tl = await s.service.getRounds(o.id, 'buyer-1');
    expect(tl).toHaveLength(2);
    expect(tl[1]).toMatchObject({ mine: false, total: 12000 });
    expect(tl[0].termsSummary).toMatch(/Cash on delivery/);
    await expect(s.service.getRounds(o.id, 'nobody')).rejects.toThrow(ForbiddenException);
    await expect(s.service.getRounds('nope', 'buyer-1')).rejects.toThrow(NotFoundException);
  });
});

describe('accepting a round', () => {
  it('seller accepts the buyer\'s round: order at that price/qty, terms snapshot, stock deducted, no ledger rows', async () => {
    const s = await setup();
    const o: any = await open(s);
    const res: any = await s.service.accept(o.id, 'seller-1', { acceptTerms: true, roundId: s.db.offerRound.rows[0].id });
    expect(s.db.order.rows).toHaveLength(1);
    const order = s.db.order.rows[0];
    expect(order).toMatchObject({ totalAmount: 10000, platformFee: 150, netSellerAmount: 9850, unitPrice: 100, quantity: 100, status: 'CONFIRMED', termsAcceptedById: 'seller-1' });
    expect(order.paymentTermsSnapshot).toEqual(COD);
    expect(order.acceptedRoundId).toBe(s.db.offerRound.rows[0].id);
    expect(s.db.product.rows[0].quantity).toBe(400);
    expect(s.db.offerRound.rows[0]).toMatchObject({ status: 'ACCEPTED', respondedById: 'seller-1' });
    expect(s.db.offerRound.rows[0].termsAcceptedAt).toBeInstanceOf(Date);
    expect(s.db.offer.rows[0].status).toBe('ACCEPTED');
    expect(s.db.transaction.rows).toHaveLength(0);
    expect(res.order.id).toBe(order.id);
  });

  it('buyer accepts the seller\'s counter at the COUNTER price, quantity and terms', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.propose(o.id, 'seller-1', { price: 120, quantity: 80, paymentTerms: CREDIT30 });
    await s.service.acceptCounter(o.id, 'buyer-1', { acceptTerms: true });
    const order = s.db.order.rows[0];
    expect(order).toMatchObject({ totalAmount: 9600, unitPrice: 120, quantity: 80, termsAcceptedById: 'buyer-1' });
    expect(order.paymentTermsSnapshot).toMatchObject({ type: 'CREDIT', creditDays: 30 });
    expect(s.db.product.rows[0].quantity).toBe(420);
    expect(s.db.offer.rows[0].quantity).toBe(80);
    expect(s.db.orderStatusHistory.rows[0].changedBy).toBe('buyer-1');
  });

  it('refuses without explicit terms acceptance', async () => {
    const s = await setup();
    const o: any = await open(s);
    await expect(s.service.accept(o.id, 'seller-1', {})).rejects.toThrow(/accept the payment terms/);
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: false })).rejects.toThrow(BadRequestException);
    expect(s.db.order.rows).toHaveLength(0);
  });

  it('the proposer can never accept their own round', async () => {
    const s = await setup();
    const o: any = await open(s);
    await expect(s.service.acceptCounter(o.id, 'buyer-1', { acceptTerms: true })).rejects.toThrow(/no counter-offer/);
    await s.service.counter(o.id, 'seller-1', { counterPrice: 120 });
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true })).rejects.toThrow(/waiting for the buyer/);
    expect(s.db.order.rows).toHaveLength(0);
  });

  it('role and ownership checks (stranger, wrong side)', async () => {
    const s = await setup();
    s.db.user.seed({ id: 'stranger' });
    const o: any = await open(s);
    await expect(s.service.accept(o.id, 'stranger', { acceptTerms: true })).rejects.toThrow(ForbiddenException);
    await expect(s.service.accept(o.id, 'buyer-1', { acceptTerms: true })).rejects.toThrow(ForbiddenException);
    await s.service.counter(o.id, 'seller-1', { counterPrice: 120 });
    await expect(s.service.acceptCounter(o.id, 'seller-1', { acceptTerms: true })).rejects.toThrow(ForbiddenException);
    await expect(s.service.accept('nope', 'seller-1', { acceptTerms: true })).rejects.toThrow(NotFoundException);
  });

  it('blocks non-approved users before touching the offer', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.db.user.rows[0].kycStatus = 'SUBMITTED';
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true })).rejects.toThrow(ForbiddenException);
  });

  it.each(['ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'])('refuses an offer that is already %s', async (status) => {
    const s = await setup();
    const o: any = await open(s);
    s.db.offer.rows[0].status = status;
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true })).rejects.toThrow(BadRequestException);
    expect(s.db.order.rows).toHaveLength(0);
  });

  it('refuses an expired round and marks it EXPIRED', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.db.offer.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true })).rejects.toThrow('This offer has expired');
    expect(s.db.offerRound.rows[0].status).toBe('EXPIRED');
  });

  it('a stale roundId cannot be accepted (409) - the buyer countered back while the seller was reviewing', async () => {
    const s = await setup();
    const o: any = await open(s);
    const seen = s.db.offerRound.rows[0].id;
    await s.service.propose(o.id, 'seller-1', { price: 120 });
    await s.service.propose(o.id, 'buyer-1', { price: 105 });
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true, roundId: seen })).rejects.toThrow(/Cannot accept|changed|waiting|already/);
    expect(s.db.order.rows).toHaveLength(0);
  });

  it('accepting a superseded round id is a 409 even when the caller is the right party', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.propose(o.id, 'seller-1', { price: 120 });
    const seenBySeller = s.db.offerRound.rows.find((r: any) => r.roundNo === 2).id;
    await s.service.propose(o.id, 'buyer-1', { price: 105 }); // buyer counters back -> round 3 is current
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true, roundId: seenBySeller })).rejects.toThrow(ConflictException);
  });

  it('rolls back everything when stock is gone', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.db.product.rows[0].quantity = 50;
    await expect(s.service.accept(o.id, 'seller-1', { acceptTerms: true })).rejects.toThrow(/no longer available/);
    expect(s.db.order.rows).toHaveLength(0);
    expect(s.db.offer.rows[0].status).toBe('PENDING');
    expect(s.db.offerRound.rows[0].status).toBe('CURRENT');
  });

  it('marks the listing SOLD at zero and closes competing offers and their rounds', async () => {
    const s = await setup();
    s.db.product.rows[0].quantity = 100;
    const a: any = await open(s);
    s.db.user.seed({ id: 'buyer-2' });
    const b: any = await s.service.create('buyer-2', { productId: 'prod-1', offeredPrice: 90, quantity: 100, acceptTerms: true });
    await s.service.accept(a.id, 'seller-1', { acceptTerms: true });
    expect(s.db.product.rows[0]).toMatchObject({ quantity: 0, status: 'SOLD' });
    expect(s.db.offer.rows.find((o: any) => o.id === b.id)).toMatchObject({ status: 'REJECTED', rejectionReason: expect.stringMatching(/sold/i) });
    expect(s.db.offerRound.rows.find((r: any) => r.offerId === b.id).status).toBe('DECLINED');
  });

  it('keeps unrelated competing offers that still fit', async () => {
    const s = await setup();
    s.db.product.rows[0].quantity = 300;
    const a: any = await open(s);
    s.db.user.seed({ id: 'buyer-2' });
    const b: any = await s.service.create('buyer-2', { productId: 'prod-1', offeredPrice: 90, quantity: 50, acceptTerms: true });
    await s.service.accept(a.id, 'seller-1', { acceptTerms: true });
    expect(s.db.offer.rows.find((o: any) => o.id === b.id).status).toBe('PENDING');
  });

  it('legacy offers whose round has no terms snapshot an explicit "not specified" arrangement', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.db.offerRound.rows[0].paymentTerms = null;
    await s.service.accept(o.id, 'seller-1', { acceptTerms: true });
    expect(s.db.order.rows[0].paymentTermsSnapshot).toEqual(LEGACY_TERMS);
  });

  it('the snapshot is a copy: editing the listing or later rounds never changes the order\'s terms', async () => {
    const s = await setup();
    const o: any = await open(s);
    await s.service.accept(o.id, 'seller-1', { acceptTerms: true });
    const before = JSON.stringify(s.db.order.rows[0].paymentTermsSnapshot);
    s.db.product.rows[0].paymentTerms = { type: 'FULL_ADVANCE' };
    s.db.offerRound.rows[0].paymentTerms.type = 'CREDIT';   // even mutating the source round object
    expect(JSON.stringify(s.db.order.rows[0].paymentTermsSnapshot)).toBe(before);
    expect(Object.isFrozen(s.db.order.rows[0].paymentTermsSnapshot)).toBe(true);
  });

  it('no service call ever updates the terms snapshot after creation', async () => {
    const s = await setup();
    const spy = jest.spyOn(s.db.order, 'update');
    const spyMany = jest.spyOn(s.db.order, 'updateMany');
    const o: any = await open(s);
    await s.service.accept(o.id, 'seller-1', { acceptTerms: true });
    const touched = [...spy.mock.calls, ...spyMany.mock.calls].filter((c: any) => c[0]?.data && 'paymentTermsSnapshot' in c[0].data);
    expect(touched).toHaveLength(0);
  });

  it('CONCURRENCY: two simultaneous accepts of the same offer create exactly one order', async () => {
    const s = await setup();
    const o: any = await open(s);
    const results = await Promise.allSettled([
      s.service.accept(o.id, 'seller-1', { acceptTerms: true }),
      s.service.accept(o.id, 'seller-1', { acceptTerms: true }),
      s.service.accept(o.id, 'seller-1', { acceptTerms: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(s.db.order.rows).toHaveLength(1);
    expect(s.db.product.rows[0].quantity).toBe(400); // stock deducted once
  });

  it('CONCURRENCY: accept racing a counter - exactly one wins and state stays consistent', async () => {
    const s = await setup();
    const o: any = await open(s);
    const results = await Promise.allSettled([
      s.service.accept(o.id, 'seller-1', { acceptTerms: true, roundId: s.db.offerRound.rows[0].id }),
      s.service.propose(o.id, 'seller-1', { price: 150 }),
    ]);
    // Either the accept won (order exists, no new round) or the counter won (no order, accept refused).
    const orders = s.db.order.rows.length;
    const current = s.db.offerRound.rows.filter((r: any) => r.status === 'CURRENT').length;
    if (orders === 1) { expect(current).toBe(0); expect(s.db.offerRound.rows).toHaveLength(1); }
    else { expect(current).toBe(1); expect(s.db.offerRound.rows).toHaveLength(2); }
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });

  it('CONCURRENCY: accept racing a withdraw leaves a consistent result', async () => {
    const s = await setup();
    const o: any = await open(s);
    await Promise.allSettled([
      s.service.accept(o.id, 'seller-1', { acceptTerms: true }),
      s.service.withdraw(o.id, 'buyer-1'),
    ]);
    const status = s.db.offer.rows[0].status;
    expect(['ACCEPTED', 'WITHDRAWN']).toContain(status);
    expect(s.db.order.rows).toHaveLength(status === 'ACCEPTED' ? 1 : 0);
  });

  it('notifies the other party with a structured destination', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.notify.mockClear();
    await s.service.accept(o.id, 'seller-1', { acceptTerms: true });
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'buyer-1', type: 'OFFER_ACCEPTED',
      data: expect.objectContaining({ route: '/buyer', tab: 'orders', entityType: 'order' }),
    }));
  });
});

describe('list queries', () => {
  it('sweep expired open offers (and their rounds) first', async () => {
    const s = await setup();
    const o: any = await open(s);
    s.db.offer.rows[0].expiresAt = new Date(Date.now() - 1000);
    s.db.offerRound.rows[0].expiresAt = new Date(Date.now() - 1000);
    await s.service.getBuyerOffers('buyer-1');
    expect(s.db.offer.rows[0].status).toBe('EXPIRED');
    expect(s.db.offerRound.rows[0].status).toBe('EXPIRED');
  });
});
