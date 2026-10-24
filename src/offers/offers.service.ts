// ─── OFFERS SERVICE ───────────────────────────────────────────────────────────
// Phase 2: an offer is a negotiation made of OfferRounds. Exactly one round is
// CURRENT; the party who did NOT propose it may accept it, decline it, or
// answer with a new round (which supersedes it). Accepting happens inside one
// transaction that holds a row lock on the offer, so a double-click, two tabs
// or a counter racing an accept can produce at most ONE order.
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationType, OfferStatus, OfferRoundStatus, OrderStatus, ProductStatus, TransactionType } from '@prisma/client';
import { recordAudit } from '../common/utils/audit.util';
import { NotificationsService } from '../notifications/notifications.service';
import { destination } from '../notifications/destinations';
import {
  IsString, IsNumber, IsOptional, IsPositive, IsBoolean, IsObject, MaxLength, Matches,
} from 'class-validator';
import { normalizePaymentTerms, describeTerms, computeSchedule, contextFromOrder, PaymentTerms } from './terms/payment-terms';

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export class CreateOfferDto {
  @IsString()
  productId: string;

  @IsNumber() @IsPositive()
  offeredPrice: number;

  @IsNumber() @IsPositive()
  quantity: number;

  @IsOptional() @IsString() @MaxLength(1000)
  message?: string;

  // Terms the buyer proposes. Omitted = the listing's own terms.
  @IsOptional() @IsObject()
  paymentTerms?: any;

  // The buyer must explicitly agree to the terms being proposed.
  @IsOptional() @IsBoolean()
  acceptTerms?: boolean;

  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9_-]+$/)
  clientRequestId?: string;
}

// Legacy seller counter (price only) - still accepted; terms/qty carry forward.
export class CounterOfferDto {
  @IsNumber() @IsPositive()
  counterPrice: number;

  @IsOptional() @IsString() @MaxLength(1000)
  counterMessage?: string;

  @IsOptional() @IsNumber() @IsPositive()
  quantity?: number;

  @IsOptional() @IsObject()
  paymentTerms?: any;

  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9_-]+$/)
  clientRequestId?: string;
}

// A new round from either party (buyer counter-back or seller counter).
export class ProposeRoundDto {
  @IsNumber() @IsPositive()
  price: number;

  @IsOptional() @IsNumber() @IsPositive()
  quantity?: number;

  @IsOptional() @IsObject()
  paymentTerms?: any;

  @IsOptional() @IsString() @MaxLength(1000)
  message?: string;

  // The round the caller was looking at; a mismatch means it changed under them.
  @IsOptional() @IsString()
  roundId?: string;

  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9_-]+$/)
  clientRequestId?: string;
}

export class AcceptRoundDto {
  @IsOptional() @IsBoolean()
  acceptTerms?: boolean;

  @IsOptional() @IsString()
  roundId?: string;
}

export const LEGACY_TERMS: PaymentTerms = {
  type: 'OTHER',
  description: 'Not specified - this offer was made before payment terms were introduced',
};

type Role = 'BUYER' | 'SELLER';

@Injectable()
export class OffersService {
  constructor(private prisma: PrismaService, private settings: SettingsService, private notifications: NotificationsService) {}

  // Accounts that aren't fully APPROVED yet can browse and answer admin
  // requests but must not transact. Checked against a fresh read rather than
  // the JWT claim, which may be stale.
  private async assertCanTransact(
    userId: string,
    action: 'make an offer on' | 'accept offers on' | 'accept counter-offers on' | 'negotiate offers on',
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } });
    if (!user || user.kycStatus !== 'APPROVED') {
      throw new ForbiddenException(`Your account must be fully approved before you can ${action} listings.`);
    }
  }

  static readonly OFFER_TTL_MS = 72 * 60 * 60 * 1000;
  private static readonly OPEN_OFFER_STATES: OfferStatus[] = [OfferStatus.PENDING, OfferStatus.COUNTERED];

  private static readonly round2 = (n: number) => Math.round(n * 100) / 100;

  // Expiry is enforced lazily: when an offer is acted on we check its
  // deadline, and list queries sweep stale rows. (No cron needed.)
  private async expireOffer(offerId: string) {
    await this.prisma.offerRound.updateMany({
      where: { offerId, status: OfferRoundStatus.CURRENT },
      data: { status: OfferRoundStatus.EXPIRED, respondedAt: new Date() },
    });
    await this.prisma.offer.updateMany({
      where: { id: offerId, status: { in: OffersService.OPEN_OFFER_STATES } },
      data: { status: OfferStatus.EXPIRED },
    });
  }

  private async failIfExpired(offer: { id: string; status: OfferStatus; expiresAt?: Date | null }) {
    if (offer.expiresAt && offer.expiresAt.getTime() < Date.now() && OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
      await this.expireOffer(offer.id);
      throw new BadRequestException('This offer has expired');
    }
  }

  private async sweepExpired(where: Record<string, any>) {
    const now = new Date();
    await this.prisma.offerRound.updateMany({
      where: { status: OfferRoundStatus.CURRENT, expiresAt: { lt: now }, offer: where },
      data: { status: OfferRoundStatus.EXPIRED, respondedAt: now },
    });
    await this.prisma.offer.updateMany({
      where: { ...where, status: { in: OffersService.OPEN_OFFER_STATES }, expiresAt: { lt: now } },
      data: { status: OfferStatus.EXPIRED },
    });
  }

  // Row lock on the offer for the rest of the transaction (serialises
  // concurrent accept / counter / decline on the same offer).
  private async lockOffer(tx: any, offerId: string) {
    await tx.$queryRaw`SELECT "id" FROM "offers" WHERE "id" = ${offerId} FOR UPDATE`;
  }

  private checkQuantity(product: { minOrderQty: number; quantity: number; unit: string }, qty: number) {
    if (qty < product.minOrderQty) throw new BadRequestException(`Minimum order is ${product.minOrderQty} ${product.unit}`);
    if (qty > product.quantity) throw new BadRequestException(`Only ${product.quantity} ${product.unit} available`);
  }

  private fmtMoney = (n: number) => `₨${Number(n).toLocaleString()}`;

  // ─── CREATE (buyer's opening round) ───────────────────────────────────────
  async create(buyerId: string, dto: CreateOfferDto) {
    await this.assertCanTransact(buyerId, 'make an offer on');

    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.status !== ProductStatus.ACTIVE) throw new BadRequestException('This listing is not available for offers');
    if (product.sellerId === buyerId) throw new BadRequestException('Cannot make offer on your own product');
    this.checkQuantity(product, dto.quantity);

    const rawTerms = dto.paymentTerms ?? (product as any).paymentTerms;
    if (!rawTerms) throw new BadRequestException('Choose payment terms for your offer (the seller did not set default terms on this listing).');
    const terms = normalizePaymentTerms(rawTerms);
    if (dto.acceptTerms !== true) throw new BadRequestException('You must accept the payment terms to send this offer.');

    // Idempotent replay: same buyer + same Idempotency-Key returns the offer already created.
    if (dto.clientRequestId) {
      const prior = await this.prisma.offerRound.findFirst({
        where: { clientRequestId: dto.clientRequestId, proposerId: buyerId, roundNo: 1 },
        select: { offerId: true },
      });
      if (prior) return this.loadOffer(prior.offerId);
    }

    const offerId = randomUUID();
    const roundId = randomUUID();
    const expiresAt = new Date(Date.now() + OffersService.OFFER_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.offer.create({
        data: {
          id: offerId, productId: dto.productId, buyerId, offeredPrice: dto.offeredPrice,
          quantity: dto.quantity, message: dto.message, expiresAt, currentRoundId: roundId,
        },
      });
      await tx.offerRound.create({
        data: {
          id: roundId, offerId, roundNo: 1, proposerId: buyerId, proposerRole: 'BUYER',
          price: dto.offeredPrice, quantity: dto.quantity, paymentTerms: terms as any,
          message: dto.message, status: OfferRoundStatus.CURRENT, expiresAt,
          clientRequestId: dto.clientRequestId || null,
          termsAcceptedAt: new Date(),
        },
      });
    });
    const created = await this.loadOffer(offerId);
    const buyerName = await this.prisma.user.findUnique({ where: { id: buyerId }, select: { profile: { select: { fullName: true } } } });
    await this.notifications.notify({
      userId: product.sellerId,
      type: NotificationType.OFFER_RECEIVED,
      title: 'New offer on your listing',
      body: `${buyerName?.profile?.fullName || 'A buyer'} offered ${this.fmtMoney(dto.offeredPrice)} × ${dto.quantity} ${product.unit} for ${product.name}. Terms: ${describeTerms(terms)}.`,
      data: destination('/seller', { tab: 'offers', entityType: 'offer', entityId: offerId }),
    });
    await recordAudit(this.prisma, buyerId, 'offer_round_proposed', 'offer', offerId, { roundNo: 1, price: dto.offeredPrice, quantity: dto.quantity, terms });
    return created;
  }

  private loadOffer(offerId: string) {
    return this.prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        product: { select: { name: true, unit: true, sellerId: true } },
        buyer: { select: { profile: { select: { fullName: true } } } },
        rounds: { orderBy: { roundNo: 'asc' } },
      },
    });
  }

  // ─── PROPOSE A NEW ROUND (counter / counter-back) ─────────────────────────
  async propose(offerId: string, actorId: string, dto: ProposeRoundDto, opts: { requirePending?: boolean } = {}) {
    await this.assertCanTransact(actorId, 'negotiate offers on');

    const pre = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: true } });
    if (!pre) throw new NotFoundException('Offer not found');
    const role: Role | null = pre.buyerId === actorId ? 'BUYER' : pre.product.sellerId === actorId ? 'SELLER' : null;
    if (!role) throw new ForbiddenException('Not your offer');
    if (opts.requirePending && pre.status !== OfferStatus.PENDING) throw new BadRequestException('Can only counter pending offers');
    await this.failIfExpired(pre);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockOffer(tx, offerId);
      const offer = await tx.offer.findUnique({ where: { id: offerId }, include: { product: true } });
      if (!offer || !OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
        throw new BadRequestException(`This negotiation is already closed (${offer?.status ?? 'unknown'}).`);
      }
      const current = await tx.offerRound.findFirst({ where: { offerId, status: OfferRoundStatus.CURRENT } });
      if (!current) throw new BadRequestException('This negotiation has no open round.');
      if (dto.roundId && dto.roundId !== current.id) {
        throw new ConflictException('This offer changed while you were looking at it - a newer round exists. Refresh and review it.');
      }
      if (current.proposerRole === role) {
        throw new BadRequestException('You already have a proposal on the table - wait for the other party to respond.');
      }

      const quantity = dto.quantity ?? current.quantity;
      this.checkQuantity(offer.product, quantity);
      const rawTerms = dto.paymentTerms ?? current.paymentTerms;
      const terms = rawTerms ? normalizePaymentTerms(rawTerms) : normalizePaymentTerms((offer.product as any).paymentTerms ?? LEGACY_TERMS);

      const newId = randomUUID();
      const expiresAt = new Date(Date.now() + OffersService.OFFER_TTL_MS);
      await tx.offerRound.update({
        where: { id: current.id },
        data: { status: OfferRoundStatus.SUPERSEDED, supersededById: newId, respondedAt: new Date(), respondedById: actorId },
      });
      const round = await tx.offerRound.create({
        data: {
          id: newId, offerId, roundNo: current.roundNo + 1, proposerId: actorId, proposerRole: role,
          price: dto.price, quantity, paymentTerms: terms as any, message: dto.message,
          status: OfferRoundStatus.CURRENT, expiresAt, clientRequestId: dto.clientRequestId || null,
        },
      });
      await tx.offer.update({
        where: { id: offerId },
        data: {
          status: role === 'SELLER' ? OfferStatus.COUNTERED : OfferStatus.PENDING,
          ...(role === 'SELLER'
            ? { counterPrice: dto.price, counterMessage: dto.message }
            : { offeredPrice: dto.price, message: dto.message, counterPrice: null, counterMessage: null }),
          quantity, expiresAt, currentRoundId: newId,
        },
      });
      return { round, offer };
    }).catch(async (err: any) => {
      if (err?.code === 'P2002' && dto.clientRequestId) {
        const replay = await this.prisma.offerRound.findFirst({ where: { offerId, clientRequestId: dto.clientRequestId } });
        if (replay) return { round: replay, offer: pre, replay: true };
      }
      throw err;
    });

    if (!(result as any).replay) {
      const other = role === 'SELLER' ? pre.buyerId : pre.product.sellerId;
      await this.notifications.notify({
        userId: other,
        type: NotificationType.OFFER_RECEIVED,
        title: role === 'SELLER' ? 'The seller sent a counter-offer' : 'The buyer sent a counter-offer',
        body: `${this.fmtMoney(dto.price)} × ${result.round.quantity} ${pre.product.unit} on ${pre.product.name} (round ${result.round.roundNo}). Terms: ${describeTerms(result.round.paymentTerms as any)}. Respond within 72 hours.`,
        data: destination(role === 'SELLER' ? '/buyer' : '/seller', { tab: 'offers', entityType: 'offer', entityId: offerId }),
      });
      await recordAudit(this.prisma, actorId, 'offer_round_proposed', 'offer', offerId, {
        roundNo: result.round.roundNo, role, price: dto.price, quantity: result.round.quantity, terms: result.round.paymentTerms,
      });
    }
    return this.loadOffer(offerId);
  }

  // Legacy seller counter (price + message). Quantity and terms carry forward unless given.
  async counter(offerId: string, sellerId: string, dto: CounterOfferDto) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: true } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    return this.propose(offerId, sellerId, {
      price: dto.counterPrice, message: dto.counterMessage, quantity: dto.quantity,
      paymentTerms: dto.paymentTerms, clientRequestId: dto.clientRequestId,
    }, { requirePending: true });
  }

  // ─── ACCEPT ───────────────────────────────────────────────────────────────
  // Seller accepts the buyer's CURRENT round (legacy route /accept).
  async accept(offerId: string, sellerId: string, dto: AcceptRoundDto = {}) {
    await this.assertCanTransact(sellerId, 'accept offers on');
    return this.acceptRound(offerId, sellerId, dto, 'SELLER');
  }

  // Buyer accepts the seller's CURRENT round (legacy route /accept-counter).
  async acceptCounter(offerId: string, buyerId: string, dto: AcceptRoundDto = {}) {
    await this.assertCanTransact(buyerId, 'accept counter-offers on');
    return this.acceptRound(offerId, buyerId, dto, 'BUYER');
  }

  private async acceptRound(offerId: string, actorId: string, dto: AcceptRoundDto, expectRole: Role) {
    const pre = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: true } });
    if (!pre) throw new NotFoundException('Offer not found');
    const role: Role | null = pre.buyerId === actorId ? 'BUYER' : pre.product.sellerId === actorId ? 'SELLER' : null;
    if (!role) throw new ForbiddenException(expectRole === 'SELLER' ? 'Not your listing' : 'Not your offer');
    if (role !== expectRole) throw new ForbiddenException(expectRole === 'SELLER' ? 'Only the seller can accept here' : 'Only the buyer can accept here');
    if (pre.status === OfferStatus.COUNTERED && role === 'SELLER') {
      throw new BadRequestException('You countered this offer - waiting for the buyer to accept or decline your counter.');
    }
    if (pre.status === OfferStatus.PENDING && role === 'BUYER') {
      throw new BadRequestException('There is no counter-offer to accept on this offer');
    }
    if (!OffersService.OPEN_OFFER_STATES.includes(pre.status)) {
      throw new BadRequestException(`Cannot accept offer in ${pre.status} status`);
    }
    await this.failIfExpired(pre);
    if (dto.acceptTerms !== true) throw new BadRequestException('You must review and accept the payment terms to accept this offer.');

    const sellerId = pre.product.sellerId;
    const platformFeePct = await this.settings.getPlatformFeePct();
    const round2 = OffersService.round2;

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockOffer(tx, offerId);
      const offer = await tx.offer.findUnique({ where: { id: offerId } });
      if (!offer || !OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
        throw new BadRequestException('This offer was already processed');
      }
      const round = await tx.offerRound.findFirst({ where: { offerId, status: OfferRoundStatus.CURRENT } });
      if (!round) throw new BadRequestException('This offer was already processed');
      if (dto.roundId && dto.roundId !== round.id) {
        throw new ConflictException('This offer changed while you were reviewing it - a newer round exists. Refresh and review it.');
      }
      if (round.proposerRole === role) {
        throw new BadRequestException('You proposed the current terms - the other party has to accept them.');
      }

      const unitPrice = Number(round.price);
      const quantity = round.quantity;
      const totalAmount = round2(unitPrice * quantity);
      const platformFee = round2((totalAmount * platformFeePct) / 100);
      const snapshot = round.paymentTerms ? normalizePaymentTerms(round.paymentTerms) : LEGACY_TERMS;

      const guarded = await tx.offer.updateMany({
        where: { id: offerId, status: { in: OffersService.OPEN_OFFER_STATES } },
        data: { status: OfferStatus.ACCEPTED, offeredPrice: role === 'SELLER' ? unitPrice : undefined, quantity },
      });
      if (guarded.count === 0) throw new BadRequestException('This offer was already processed');

      const acceptedRound = await tx.offerRound.updateMany({
        where: { id: round.id, status: OfferRoundStatus.CURRENT },
        data: { status: OfferRoundStatus.ACCEPTED, respondedAt: new Date(), respondedById: actorId, termsAcceptedAt: new Date() },
      });
      if (acceptedRound.count === 0) throw new BadRequestException('This offer was already processed');

      const stock = await tx.product.updateMany({
        where: { id: offer.productId, status: { in: [ProductStatus.ACTIVE, ProductStatus.UNDER_OFFER] }, quantity: { gte: quantity } },
        data: { quantity: { decrement: quantity } },
      });
      if (stock.count === 0) throw new BadRequestException('This listing is no longer available in the offered quantity');

      const product = await tx.product.findUnique({ where: { id: offer.productId }, select: { quantity: true } });
      const remaining = product?.quantity ?? 0;
      if (remaining <= 0) await tx.product.update({ where: { id: offer.productId }, data: { status: ProductStatus.SOLD } });

      // Competing open offers that can no longer be filled are closed (offer AND its current round).
      const competing = await tx.offer.findMany({
        where: { productId: offer.productId, id: { not: offerId }, status: { in: OffersService.OPEN_OFFER_STATES }, quantity: { gt: Math.max(remaining, 0) } },
        select: { id: true },
      });
      if (competing.length) {
        const ids = competing.map((c: any) => c.id);
        await tx.offer.updateMany({
          where: { id: { in: ids }, status: { in: OffersService.OPEN_OFFER_STATES } },
          data: { status: OfferStatus.REJECTED, rejectionReason: remaining <= 0 ? 'This listing has been sold.' : 'Not enough stock left after another order was confirmed.' },
        });
        await tx.offerRound.updateMany({
          where: { offerId: { in: ids }, status: OfferRoundStatus.CURRENT },
          data: { status: OfferRoundStatus.DECLINED, respondedAt: new Date() },
        });
      }

      const acceptedAt = new Date();
      const order = await tx.order.create({
        data: {
          offerId, sellerId, buyerId: offer.buyerId, totalAmount, platformFeePct, platformFee,
          netSellerAmount: round2(totalAmount - platformFee),
          status: OrderStatus.CONFIRMED,
          unitPrice, quantity, acceptedRoundId: round.id,
          paymentTermsSnapshot: Object.freeze({ ...snapshot }) as any,
          termsAcceptedAt: acceptedAt, termsAcceptedById: actorId,
          statusHistory: {
            create: { status: OrderStatus.CONFIRMED, changedBy: actorId, note: role === 'SELLER' ? 'Offer accepted' : 'Counter-offer accepted by buyer' },
          },
        },
        include: {
          offer: { include: { product: { select: { name: true, unit: true } } } },
          seller: { select: { profile: { select: { fullName: true } } } },
          buyer: { select: { profile: { select: { fullName: true } } } },
        },
      });
      // No ledger rows here on purpose: the sale is booked when the order is COMPLETED.
      const updatedOffer = await tx.offer.findUnique({ where: { id: offerId } });
      return { offer: updatedOffer, order, unitPrice, totalAmount, roundNo: round.roundNo, snapshot };
    });

    const otherParty = role === 'SELLER' ? pre.buyerId : sellerId;
    await this.notifications.notify({
      userId: otherParty,
      type: NotificationType.OFFER_ACCEPTED,
      title: role === 'SELLER' ? 'Your offer was accepted' : 'Your counter-offer was accepted',
      body: `An order of ${this.fmtMoney(result.totalAmount)} was created at ${this.fmtMoney(result.unitPrice)} per unit. Terms: ${describeTerms(result.snapshot)}.`,
      data: destination(role === 'SELLER' ? '/buyer' : '/seller', { tab: 'orders', entityType: 'order', entityId: (result as any).order?.id }),
    });
    await recordAudit(this.prisma, actorId, 'offer_round_accepted', 'offer', offerId, {
      roundNo: result.roundNo, orderId: (result as any).order?.id, unitPrice: result.unitPrice, terms: result.snapshot,
    });
    return { offer: result.offer, order: result.order };
  }

  // ─── DECLINE / WITHDRAW ───────────────────────────────────────────────────
  private async closeOffer(offerId: string, actorId: string, offerStatus: OfferStatus, reason?: string) {
    const roundBefore = await this.prisma.$transaction(async (tx) => {
      await this.lockOffer(tx, offerId);
      const res = await tx.offer.updateMany({
        where: { id: offerId, status: { in: OffersService.OPEN_OFFER_STATES } },
        data: { status: offerStatus, rejectionReason: reason || undefined },
      });
      if (res.count === 0) throw new BadRequestException('This offer was already processed');
      const cur = await tx.offerRound.findFirst({ where: { offerId, status: OfferRoundStatus.CURRENT } });
      if (cur) {
        await tx.offerRound.update({
          where: { id: cur.id },
          data: {
            status: cur.proposerId === actorId ? OfferRoundStatus.WITHDRAWN : OfferRoundStatus.DECLINED,
            respondedAt: new Date(), respondedById: actorId,
          },
        });
      }
      return cur;
    });
    await recordAudit(this.prisma, actorId, offerStatus === OfferStatus.REJECTED ? 'offer_declined' : 'offer_withdrawn', 'offer', offerId, { reason, roundNo: roundBefore?.roundNo });
  }

  async reject(offerId: string, sellerId: string, reason?: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: true } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (!OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
      throw new BadRequestException(`Cannot reject an offer in ${offer.status} status`);
    }
    await this.closeOffer(offerId, sellerId, OfferStatus.REJECTED, reason);
    await this.notifications.notify({
      userId: offer.buyerId,
      type: NotificationType.OFFER_REJECTED,
      title: 'Your offer was declined',
      body: `The seller declined your offer on ${offer.product.name}${reason ? `: ${reason}` : '.'}`,
      data: destination('/buyer', { tab: 'offers', entityType: 'offer', entityId: offerId }),
    });
    return this.loadOffer(offerId);
  }

  // Buyer withdraws an open offer, or declines the seller's counter.
  async withdraw(offerId: string, buyerId: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: { select: { sellerId: true, name: true } } } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.buyerId !== buyerId) throw new ForbiddenException('Not your offer');
    if (!OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
      throw new BadRequestException(`Cannot withdraw an offer in ${offer.status} status`);
    }
    await this.closeOffer(offerId, buyerId, OfferStatus.WITHDRAWN);
    if (offer.product?.sellerId) {
      await this.notifications.notify({
        userId: offer.product.sellerId,
        type: NotificationType.OFFER_REJECTED,
        title: offer.status === OfferStatus.COUNTERED ? 'Your counter-offer was declined' : 'An offer was withdrawn',
        body: `The buyer ${offer.status === OfferStatus.COUNTERED ? 'declined your counter on' : 'withdrew their offer on'} ${offer.product.name}.`,
        data: destination('/seller', { tab: 'offers', entityType: 'offer', entityId: offerId }),
      });
    }
    return this.loadOffer(offerId);
  }

  // ─── READS ────────────────────────────────────────────────────────────────
  async getRounds(offerId: string, userId: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: { select: { sellerId: true, unit: true } } } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.buyerId !== userId && offer.product.sellerId !== userId) throw new ForbiddenException('Access denied');
    const rounds = await this.prisma.offerRound.findMany({ where: { offerId }, orderBy: { roundNo: 'asc' } });
    return rounds.map((r: any) => ({
      ...r,
      mine: r.proposerId === userId,
      termsSummary: describeTerms(r.paymentTerms),
      total: OffersService.round2(Number(r.price) * r.quantity),
    }));
  }

  async getSellerOffers(sellerId: string) {
    await this.sweepExpired({ product: { sellerId } });
    // Estimate shown on the seller's accept review; the % in force at acceptance is what gets frozen on the order.
    const platformFeePct = await this.settings.getPlatformFeePct();
    const offers = await this.prisma.offer.findMany({
      where: { product: { sellerId } },
      include: {
        product: { select: { id: true, name: true, unit: true, askingPrice: true } },
        buyer: { select: { id: true, profile: { select: { fullName: true, city: true } }, kycStatus: true } },
        rounds: { orderBy: { roundNo: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return offers.map((o: any) => ({ ...o, platformFeePct }));
  }

  async getBuyerOffers(buyerId: string) {
    await this.sweepExpired({ buyerId });
    return this.prisma.offer.findMany({
      where: { buyerId },
      include: {
        product: {
          select: { id: true, name: true, unit: true, askingPrice: true, seller: { select: { profile: { select: { fullName: true } } } } },
        },
        rounds: { orderBy: { roundNo: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

// ─── ORDER STATUS STATE MACHINE (Round 2, Milestone 7) ────────────────────────
// Previously PATCH /orders/:id/status accepted *any* OrderStatus value from
// *either* party to the order with zero transition rules — a buyer or seller
// could jump an order straight to COMPLETED, or quietly move it out of
// DISPUTED before an admin ever resolved it, sidestepping
// OrdersService.adminResolveDispute entirely. This mirrors the explicit
// allow-list pattern WarehouseService already uses for booking status
// (see ALLOWED_TRANSITIONS there) — each transition names which party
// (seller, buyer, or both) is permitted to make it. DISPUTED is
// deliberately terminal here: only the admin-only resolve-dispute endpoint
// can move an order out of DISPUTED.
type OrderParty = 'seller' | 'buyer';
const ORDER_TRANSITIONS: Record<OrderStatus, { to: OrderStatus; allowedParties: OrderParty[] }[]> = {
  [OrderStatus.PENDING]: [],
  [OrderStatus.CONFIRMED]: [
    { to: OrderStatus.IN_TRANSIT, allowedParties: ['seller'] },
    { to: OrderStatus.CANCELLED, allowedParties: ['seller', 'buyer'] },
    { to: OrderStatus.DISPUTED, allowedParties: ['seller', 'buyer'] },
  ],
  [OrderStatus.IN_TRANSIT]: [
    { to: OrderStatus.DELIVERED, allowedParties: ['buyer'] },
    { to: OrderStatus.DISPUTED, allowedParties: ['seller', 'buyer'] },
  ],
  [OrderStatus.DELIVERED]: [
    { to: OrderStatus.COMPLETED, allowedParties: ['buyer'] },
    { to: OrderStatus.DISPUTED, allowedParties: ['seller', 'buyer'] },
  ],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.DISPUTED]: [], // only OrdersService.adminResolveDispute may move out of DISPUTED
};

// ─── ORDERS SERVICE ───────────────────────────────────────────────────────────
@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  // Books a finished sale in the ledger — called inside the same
  // transaction that moves the order to COMPLETED (by the buyer, or by an
  // admin resolving a dispute in the seller's favour). Cancelled / disputed
  // / in-flight orders never appear here, so ledger totals reflect realised
  // sales only. Idempotent: a second call for the same order writes nothing.
  private async recordSettlement(
    tx: any,
    order: { id: string; sellerId: string; platformFee: any; platformFeePct: any; netSellerAmount: any },
  ) {
    const already = await tx.transaction.findFirst({
      where: { referenceId: order.id, referenceType: 'order', type: TransactionType.ORDER_PAYMENT },
      select: { id: true },
    });
    if (already) return;
    await tx.transaction.createMany({
      data: [
        {
          userId: order.sellerId,
          type: TransactionType.ORDER_PAYMENT,
          amount: Number(order.netSellerAmount),
          description: `Net proceeds from completed order ${order.id}`,
          referenceId: order.id,
          referenceType: 'order',
        },
        {
          userId: order.sellerId,
          type: TransactionType.PLATFORM_FEE,
          amount: Number(order.platformFee),
          description: `Platform fee (${Number(order.platformFeePct)}%) on completed order ${order.id}`,
          referenceId: order.id,
          referenceType: 'order',
        },
      ],
    });
  }

  async findAll(userId: string, role: 'seller' | 'buyer', status?: string) {
    const where: any = role === 'seller' ? { sellerId: userId } : { buyerId: userId };
    if (status) where.status = status;

    return this.prisma.order.findMany({
      where,
      include: {
        offer: {
          include: {
            product: { select: { id: true, name: true, unit: true, category: true } },
          },
        },
        seller: { select: { profile: { select: { fullName: true, city: true } } } },
        buyer: { select: { profile: { select: { fullName: true, city: true } } } },
        payments: { select: { amount: true, status: true, method: true, paidAt: true } },
        _count: { select: { testingRequests: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        offer: { include: { product: { include: { riceDetails: true, media: { take: 1 } } }, rounds: { orderBy: { roundNo: 'asc' } } } },
        sellerInvoices: { orderBy: { issuedAt: 'desc' }, select: { id: true, invoiceNumber: true, status: true, version: true, orderAmount: true, dueDate: true } },
        seller: { select: { profile: true, kycStatus: true } },
        buyer: { select: { profile: true, kycStatus: true } },
        payments: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        testingRequests: {
          include: { agency: { select: { name: true, city: true, user: { select: { profile: { select: { fullName: true } } } } } } },
        },
        transportRequest: {
          include: { provider: { select: { companyName: true, user: { select: { profile: { select: { fullName: true } } } } } } },
        },
        ratings: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.sellerId !== userId && order.buyerId !== userId) throw new ForbiddenException('Access denied');
    const terms = (order as any).paymentTermsSnapshot as PaymentTerms | null;
    return {
      ...order,
      paymentTermsSummary: describeTerms(terms),
      paymentSchedule: computeSchedule(terms, Number(order.totalAmount), contextFromOrder(order as any)),
    };
  }

  // Cancelling an order puts its quantity back on the listing (and
  // re-opens it if that sale had marked it SOLD).
  // A cancelled order can't be paid: any open invoice is voided with it.
  private async voidOpenInvoices(tx: any, orderId: string) {
    await tx.sellerInvoice.updateMany({
      where: { orderId, status: { in: ['ISSUED', 'PAYMENT_SUBMITTED'] } },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: 'Order cancelled' },
    });
  }

  private async restoreStock(tx: any, offer: { productId: string; quantity: number }) {
    await tx.product.update({
      where: { id: offer.productId },
      data: { quantity: { increment: offer.quantity } },
    });
    await tx.product.updateMany({
      where: { id: offer.productId, status: ProductStatus.SOLD },
      data: { status: ProductStatus.ACTIVE },
    });
  }

  async updateStatus(orderId: string, userId: string, status: OrderStatus, note?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { offer: { select: { productId: true, quantity: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');

    const party: OrderParty | null =
      order.sellerId === userId ? 'seller' : order.buyerId === userId ? 'buyer' : null;
    if (!party) throw new ForbiddenException('Access denied');

    if (order.status === OrderStatus.DISPUTED) {
      throw new BadRequestException(
        'This order is under dispute review — only an admin can change its status from here',
      );
    }

    const transition = ORDER_TRANSITIONS[order.status]?.find((t) => t.to === status);
    if (!transition) {
      throw new BadRequestException(`Order cannot move from ${order.status} to ${status}`);
    }
    if (!transition.allowedParties.includes(party)) {
      throw new ForbiddenException(
        `Only the ${transition.allowedParties.join(' or ')} can move an order from ${order.status} to ${status}`,
      );
    }

    const trimmedNote = note?.trim();
    if ((status === OrderStatus.DISPUTED || status === OrderStatus.CANCELLED) && (!trimmedNote || trimmedNote.length < 5)) {
      throw new BadRequestException(
        `Please give a reason (at least 5 characters) when ${status === OrderStatus.DISPUTED ? 'raising a dispute' : 'cancelling an order'}`,
      );
    }
    note = trimmedNote || undefined;

    const extraData: Record<string, any> = {};
    if (status === OrderStatus.COMPLETED) extraData.completedAt = new Date();
    if (status === OrderStatus.CANCELLED) {
      extraData.cancelledAt = new Date();
      extraData.cancelReason = note;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Guard on the status we validated against so two simultaneous
      // updates can't both apply.
      const res = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status, ...extraData },
      });
      if (res.count === 0) throw new BadRequestException('This order was just updated — please refresh and try again');
      await tx.orderStatusHistory.create({ data: { orderId, status, changedBy: userId, note } });
      if (status === OrderStatus.CANCELLED && order.offer) await this.restoreStock(tx, { productId: order.offer.productId, quantity: order.quantity ?? order.offer.quantity });
      if (status === OrderStatus.CANCELLED) await this.voidOpenInvoices(tx, orderId);
      if (status === OrderStatus.COMPLETED) await this.recordSettlement(tx, order);
      return tx.order.findUnique({ where: { id: orderId } });
    });

    const other = userId === order.sellerId ? order.buyerId : order.sellerId;
    await this.notifications.notify({
      userId: other,
      type: NotificationType.ORDER_UPDATE,
      title: `Order ${status.toLowerCase().replace('_', ' ')}`,
      body: `Order ${orderId.slice(0, 8)} is now ${status.replace('_', ' ').toLowerCase()}${note ? ` — ${note}` : ''}.`,
      data: destination(other === order.buyerId ? '/buyer' : '/seller', { tab: 'orders', entityType: 'order', entityId: orderId }),
    });
    return updated;
  }

  // Server-side totals for the admin dashboard. Previously the browser summed
  // whichever 200 orders it had loaded — and included cancelled / disputed
  // orders. Revenue is now the platform fee on COMPLETED orders only;
  // "in progress" value is shown separately and is NOT revenue.
  async getAdminSummary() {
    const [byStatus, completed, inProgress] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.aggregate({
        where: { status: OrderStatus.COMPLETED },
        _sum: { totalAmount: true, platformFee: true, netSellerAmount: true },
      }),
      this.prisma.order.aggregate({
        where: { status: { in: [OrderStatus.CONFIRMED, OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED] } },
        _sum: { totalAmount: true, platformFee: true },
      }),
    ]);
    const counts: Record<string, number> = {};
    byStatus.forEach((g: any) => { counts[g.status] = g._count._all; });
    const n = (v: any) => Number(v ?? 0);
    return {
      counts,
      totalOrders: Object.values(counts).reduce((a, b) => a + b, 0),
      completed: {
        orderValue: n(completed._sum.totalAmount),
        platformRevenue: n(completed._sum.platformFee),
        netToSellers: n(completed._sum.netSellerAmount),
      },
      inProgress: {
        orderValue: n(inProgress._sum.totalAmount),
        expectedPlatformFees: n(inProgress._sum.platformFee),
      },
    };
  }

  async getAdminOrders(status?: string, page = 1, limit = 20) {
    const where: any = {};
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          offer: { include: { product: { select: { name: true } } } },
          seller: { select: { profile: { select: { fullName: true } } } },
          buyer: { select: { profile: { select: { fullName: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Admin resolves a disputed order. OrderStatus.DISPUTED existed in the
   * schema with no way to act on it — this closes that gap. resolution
   * determines the outcome: 'completed' finalizes the sale as-is,
   * 'cancelled' voids it (e.g. for a refund handled outside the platform).
   */
  async adminResolveDispute(orderId: string, adminId: string, resolution: 'completed' | 'cancelled', note: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { offer: { select: { productId: true, quantity: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException('Only disputed orders can be resolved through this endpoint');
    }

    const newStatus = resolution === 'completed' ? OrderStatus.COMPLETED : OrderStatus.CANCELLED;

    const resolved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          ...(resolution === 'completed' ? { completedAt: new Date() } : { cancelledAt: new Date(), cancelReason: note }),
        },
      });
      await tx.orderStatusHistory.create({
        data: { orderId, status: newStatus, changedBy: adminId, note: `Dispute resolved by admin: ${note}` },
      });
      if (newStatus === OrderStatus.CANCELLED && order.offer) await this.restoreStock(tx, { productId: order.offer.productId, quantity: order.quantity ?? order.offer.quantity });
      if (newStatus === OrderStatus.CANCELLED) await this.voidOpenInvoices(tx, orderId);
      if (newStatus === OrderStatus.COMPLETED) await this.recordSettlement(tx, order);
      return updated;
    });
    await recordAudit(this.prisma, adminId, 'dispute_resolved', 'order', orderId, { resolution, note });
    await this.notifications.notifyMany([order.buyerId, order.sellerId].map((uid) => ({
      userId: uid,
      type: NotificationType.ORDER_UPDATE,
      title: 'Dispute resolved',
      body: `An admin resolved the dispute on order ${orderId.slice(0, 8)} as ${resolution}. ${note}`,
      data: destination(uid === order.buyerId ? '/buyer' : '/seller', { tab: 'orders', entityType: 'order', entityId: orderId }),
    })));
    return resolved;
  }
}
