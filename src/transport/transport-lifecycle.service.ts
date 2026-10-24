// ─── TRANSPORT LIFECYCLE SERVICE (Phase 3) ────────────────────────────────────
// Quote rounds (quote / counter / accept / reject), booking, driver details,
// tracking, delivery acknowledgement, cancellation and the public tracking view.
//
// Conventions (same as the offer rounds in Phase 2):
//  * one CURRENT round per request: partial unique index + a FOR UPDATE row lock
//    (`lockRequest`) taken before any round / status change;
//  * accepting a round is ONE transaction: round -> ACCEPTED, request -> BOOKED at
//    that round's price (agreedPrice is then immutable, also enforced by a DB trigger);
//  * `clientRequestId` (Idempotency-Key) makes a retried propose a replay, not a duplicate;
//  * the legacy columns quotedPrice / quoteNote / quotedAt mirror the CURRENT round but are
//    never the source of truth.
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotificationType } from '@prisma/client';
import {
  IsString, IsOptional, IsNumber, IsPositive, IsDateString, MaxLength, MinLength, Max, Min, Matches, IsIn, IsObject, IsBoolean,
  IsArray, ArrayMaxSize, ValidateNested,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { destination } from '../notifications/destinations';
import { normalizePaymentTerms, describeTerms } from '../offers/terms/payment-terms';
import { Type } from 'class-transformer';
import { formatDocumentNumber } from '../common/utils/document-number.util';
import { recordAudit } from '../common/utils/audit.util';
import {
  Party, QUOTE_TTL_MS, OPEN_REQUEST_STATES, LIVE_SHIPMENT_STATES, PHONE, money, partyOf, refLabel, computeTotal, Charge,
  shapeRequest, shapePublicTracking,
} from './transport.shared';

export class ChargeDto {
  @IsString() @MinLength(2) @MaxLength(60) label: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(1_000_000_000) amount: number;
}

export class QuoteRoundDto {
  // Base freight. Extra charges are listed separately; the all-in total is computed here, never sent.
  @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(1_000_000_000)
  price: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ChargeDto)
  additionalCharges?: ChargeDto[];
  @IsOptional() @IsDateString() estimatedPickup?: string;
  @IsOptional() @IsDateString() estimatedArrival?: string;
  @IsOptional() @IsString() @MaxLength(300) vehicleDetails?: string;
  // Same canonical shape as marketplace terms (src/offers/terms). Required on the first quote; later rounds carry it forward.
  @IsOptional() @IsObject() paymentTerms?: any;
  @IsOptional() @IsString() @MaxLength(1000) conditions?: string;
  // How long this proposal stays open (hours, default 72).
  @IsOptional() @IsNumber() @Min(1) @Max(168) validHours?: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  // The round the sender was looking at; a newer one => 409 so nobody answers a stale price.
  @IsOptional() @IsString() roundId?: string;
  clientRequestId?: string; // set by the controller from the Idempotency-Key header
}

export class AcceptQuoteDto {
  @IsOptional() @IsString() roundId?: string;
  // Explicit acceptance of the price, payment terms and conditions being agreed.
  @IsOptional() @IsBoolean() acceptTerms?: boolean;
}

export class ReasonDto {
  @IsString() @MinLength(5) @MaxLength(500)
  reason: string;
}

export class OptionalReasonDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class DriverDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) driverName?: string;
  @IsOptional() @IsString() @Matches(PHONE, { message: 'Enter a valid phone number (digits, optional leading +).' }) driverPhone?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(20) vehicleRegNo?: string;
}

export class TrackingUpdateDto extends DriverDto {
  @IsOptional() @IsIn(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED']) status?: 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED';
  @IsOptional() @IsString() @MaxLength(200) currentLocation?: string;
  @IsOptional() @IsDateString() estimatedArrival?: string;
  // Delivery evidence, required when marking DELIVERED (who received the goods).
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) receiverName?: string;
  @IsOptional() @IsString() @MaxLength(500) deliveryNote?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) deliveredQuantityTons?: number;
}

export class AcknowledgeDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

const label = (s: string) => s.toLowerCase().replace(/_/g, ' ');

@Injectable()
export class TransportLifecycleService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  private static readonly TRACKING_NEXT: Record<string, string[]> = {
    BOOKED: ['PICKED_UP'],
    PICKED_UP: ['IN_TRANSIT', 'DELIVERED'],
    IN_TRANSIT: ['DELIVERED'],
  };

  // ─── helpers ──────────────────────────────────────────────────────────────
  private async assertApproved(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } });
    if (!u || u.kycStatus !== 'APPROVED') throw new ForbiddenException('Your account must be fully approved before you can do this.');
  }

  private async lockRequest(tx: any, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "transport_requests" WHERE "id" = ${id} FOR UPDATE`;
  }

  private dest(party: Party, requestId: string) {
    return party === 'REQUESTER'
      ? destination('/buyer', { tab: 'transport', entityType: 'transport', entityId: requestId })
      : destination('/transport-portal', { entityType: 'transport', entityId: requestId });
  }

  private async notifyParty(userId: string | null | undefined, party: Party, requestId: string, title: string, body: string) {
    if (!userId) return;
    await this.notifications.notify({
      userId, type: NotificationType.TRANSPORT_UPDATE, title, body, data: this.dest(party, requestId),
    });
  }

  private includeFull() {
    return {
      quoteRounds: { orderBy: { roundNo: 'asc' as const } },
      invoices: { orderBy: { issuedAt: 'desc' as const } },
      disputes: { orderBy: { createdAt: 'desc' as const } },
      requester: { select: { profile: { select: { fullName: true, city: true } } } },
      provider: { select: { companyName: true, user: { select: { profile: { select: { fullName: true } } } } } },
      order: { select: { id: true, offer: { select: { product: { select: { name: true } } } } } },
    };
  }

  // A CURRENT round past its deadline is closed lazily (no cron): the request goes
  // back to REQUESTED so the provider can quote again.
  private async expireStale(requestId: string) {
    const now = new Date();
    const stale = await this.prisma.transportQuoteRound.findMany({
      where: { requestId, status: 'CURRENT', expiresAt: { lt: now } },
    });
    if (!stale.length) return;
    await this.prisma.transportQuoteRound.updateMany({
      where: { requestId, status: 'CURRENT', expiresAt: { lt: now } },
      data: { status: 'EXPIRED', respondedAt: now },
    });
    await this.prisma.transportRequest.updateMany({
      where: { id: requestId, status: 'QUOTED' as any },
      data: { status: 'REQUESTED' as any, currentRoundId: null, quotedPrice: null, quoteNote: null, quotedAt: null },
    });
  }

  private clearMirror = { currentRoundId: null, quotedPrice: null, quoteNote: null, quotedAt: null };

  // ─── QUOTE / COUNTER ──────────────────────────────────────────────────────
  // Provider => a quote (or a revised quote / counter-back); requester => a counter-offer.
  async propose(requestId: string, actorId: string, expect: Party, dto: QuoteRoundDto) {
    await this.assertApproved(actorId);
    const pre = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!pre) throw new NotFoundException('Request not found');
    const party = partyOf(pre, actorId);
    if (!party) throw new ForbiddenException('Not your request');
    if (party !== expect) throw new ForbiddenException(expect === 'PROVIDER' ? 'Only the transporter can send a quote' : 'Only the requester can counter a quote');
    await this.expireStale(requestId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockRequest(tx, requestId);
      const req = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new NotFoundException('Request not found');
      if (!OPEN_REQUEST_STATES.includes(req.status as any)) {
        throw new BadRequestException(`A quote can't be sent while the request is ${label(req.status)}`);
      }
      if (!req.providerId) throw new BadRequestException('This request has not been sent to a transporter');
      if (req.providerId !== pre.providerId) throw new ConflictException('This request was reassigned - refresh and try again');

      const rounds = await tx.transportQuoteRound.findMany({ where: { requestId }, orderBy: { roundNo: 'desc' } });
      const current = rounds.find((r: any) => r.status === 'CURRENT') || null;
      if (dto.roundId && current && dto.roundId !== current.id) {
        throw new ConflictException('The price on the table changed while you were looking at it. Refresh and review the latest round.');
      }
      if (party === 'REQUESTER') {
        if (!current || current.proposerRole !== 'PROVIDER') throw new BadRequestException('There is no quote to counter yet.');
      }
      // Terms, charges, dates, vehicle, conditions carry forward from the round being answered unless re-sent.
      const rawCharges: unknown = dto.additionalCharges ?? current?.additionalCharges ?? [];

if (!Array.isArray(rawCharges)) {
  throw new BadRequestException('Additional charges must be a list.');
}

const charges: Charge[] = rawCharges.map((item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new BadRequestException('Each additional charge must have a label and amount.');
  }

  const charge = item as Record<string, unknown>;
  const label = typeof charge.label === 'string' ? charge.label.trim() : '';
  const amount = charge.amount;

  if (
    label.length < 2 ||
    label.length > 60 ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1_000_000_000 ||
    Math.round(amount * 100) !== amount * 100
  ) {
    throw new BadRequestException('Each additional charge must have a valid label and positive amount.');
  }

  return { label, amount };
});
      const rawTerms = dto.paymentTerms ?? current?.paymentTerms ?? null;
      if (!rawTerms) throw new BadRequestException('Payment terms are required on a quote.');
      const terms = normalizePaymentTerms(rawTerms);
      const estimatedPickup = dto.estimatedPickup ? new Date(dto.estimatedPickup) : current?.estimatedPickup ?? null;
      const estimatedArrival = dto.estimatedArrival ? new Date(dto.estimatedArrival) : current?.estimatedArrival ?? null;
      if (estimatedPickup && estimatedArrival && estimatedArrival < estimatedPickup) throw new BadRequestException('Expected arrival cannot be before the pickup date.');
      const total = computeTotal(dto.price, charges);
      const vehicleDetails = dto.vehicleDetails?.trim() || current?.vehicleDetails || null;
      const conditions = dto.conditions !== undefined ? (dto.conditions.trim() || null) : current?.conditions ?? null;
      const newId = randomUUID();
      const roundNo = (rounds[0]?.roundNo ?? 0) + 1;
      const expiresAt = new Date(Date.now() + (dto.validHours ?? QUOTE_TTL_MS / 3_600_000) * 3_600_000);
      if (current) {
        await tx.transportQuoteRound.update({
          where: { id: current.id },
          data: { status: 'SUPERSEDED', supersededById: newId, respondedAt: new Date(), respondedById: actorId },
        });
      }
      const round = await tx.transportQuoteRound.create({
        data: {
          id: newId, requestId, providerId: req.providerId, roundNo, proposerId: actorId, proposerRole: party,
          price: dto.price, additionalCharges: charges as any, totalPrice: total, estimatedPickup, estimatedArrival,
          vehicleDetails, paymentTerms: terms as any, conditions,
          message: dto.note?.trim() || null, status: 'CURRENT', expiresAt, clientRequestId: dto.clientRequestId || null,
        },
      });
      await tx.transportRequest.update({
        where: { id: requestId },
        data: {
          status: 'QUOTED', currentRoundId: newId, quotedPrice: total, quoteNote: dto.note?.trim() || null, quotedAt: new Date(),
          ...(estimatedArrival && { estimatedArrival }),
        },
      });
      return { round, req, replay: false };
    }).catch(async (err: any) => {
      if (err?.code === 'P2002' && dto.clientRequestId) {
        const replay = await this.prisma.transportQuoteRound.findFirst({ where: { requestId, clientRequestId: dto.clientRequestId } });
        if (replay) return { round: replay, req: pre, replay: true };
      }
      throw err;
    });

    if (!outcome.replay) {
      const { round, req } = outcome;
      const route = `${req.pickupCity} → ${req.deliveryCity}`;
      if (party === 'PROVIDER') {
        await this.notifyParty(req.requesterId, 'REQUESTER', requestId, 'You received a transport quote',
          `${money(Number(round.totalPrice))} all-in for ${route} (${refLabel(req)}). Terms: ${describeTerms(round.paymentTerms as any)}. Accept it to book, counter, or decline. Valid until ${new Date(round.expiresAt!).toLocaleString('en-GB')}.`);
      } else {
        await this.notifyParty(req.providerId, 'PROVIDER', requestId, 'The requester sent a counter-offer',
          `${money(Number(round.totalPrice))} all-in for ${route} (${refLabel(req)}), round ${round.roundNo}. Accept it, send a revised quote, or decline.`);
      }
      await recordAudit(this.prisma, actorId, 'transport_round_proposed', 'transport', requestId, { roundNo: round.roundNo, party, price: dto.price, total: Number(round.totalPrice) });
    }
    return this.getOne(requestId, actorId, 'USER');
  }

  // ─── ACCEPT THE CURRENT ROUND (either party, never their own) ─────────────
  async accept(requestId: string, actorId: string, dto: AcceptQuoteDto) {
    await this.assertApproved(actorId);
    if (!dto.roundId) throw new BadRequestException('Review the current price and accept it again (roundId is required).');
    if (dto.acceptTerms !== true) throw new BadRequestException('You must review and accept the price, payment terms and conditions to book this shipment.');
    const pre = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!pre) throw new NotFoundException('Request not found');
    const party = partyOf(pre, actorId);
    if (!party) throw new ForbiddenException('Not your request');
    // idempotent replay: already booked at exactly this round
    if (pre.status !== 'QUOTED' && pre.agreedRoundId === dto.roundId) return this.getOne(requestId, actorId, 'USER');
    await this.expireStale(requestId);

    const booked = await this.prisma.$transaction(async (tx) => {
      await this.lockRequest(tx, requestId);
      const req = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!req || req.status !== 'QUOTED') throw new BadRequestException('There is no quote to accept on this request');
      const current = await tx.transportQuoteRound.findFirst({ where: { requestId, status: 'CURRENT' } });
      if (!current) throw new BadRequestException('There is no open quote on this request (it may have expired).');
      if (current.id !== dto.roundId) throw new ConflictException('The price changed - review the new price and accept again.');
      if (current.proposerRole === party) throw new BadRequestException("You can't accept your own proposal - wait for the other party.");
      if (current.expiresAt && current.expiresAt.getTime() < Date.now()) throw new BadRequestException('This quote has expired. Ask for a new one.');
      await tx.transportQuoteRound.update({
        where: { id: current.id },
        data: { status: 'ACCEPTED', respondedAt: new Date(), respondedById: actorId },
      });
      // The confirmed TRANSPORT ORDER reference: own sequence, drawn inside this transaction.
      // (idempotent: also covers databases brought up with `db push`, which cannot create sequences)
      await tx.$executeRaw`CREATE SEQUENCE IF NOT EXISTS transport_order_seq`;
      const seqRows: any[] = await tx.$queryRaw`SELECT nextval('transport_order_seq')::int AS n`;
      const seq = Number(seqRows?.[0]?.n);
      if (!Number.isInteger(seq)) throw new BadRequestException('Could not allocate a transport order number - try again.');
      const now = new Date();
      const orderNumber = formatDocumentNumber('TRO', seq, now);
      const snapshot = (current.paymentTerms ?? { type: 'COD', description: 'Terms not recorded on this quote' }) as any;
      await tx.transportRequest.update({
        where: { id: requestId },
        data: {
          status: 'BOOKED', agreedPrice: current.totalPrice, agreedRoundId: current.id, currentRoundId: current.id,
          quotedPrice: current.totalPrice,
          orderSeq: seq, orderNumber, orderConfirmedAt: now,
          paymentTermsSnapshot: snapshot, agreedCharges: (current.additionalCharges ?? []) as any,
          agreedConditions: current.conditions ?? null, agreedPickupAt: current.estimatedPickup ?? null,
          termsAcceptedAt: now, termsAcceptedById: actorId,
          ...(current.estimatedArrival && { estimatedArrival: current.estimatedArrival }),
        },
      });
      return { req: { ...req, orderNumber }, round: current };
    });

    const { req, round } = booked;
    const other: Party = party === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
    await this.notifyParty(other === 'REQUESTER' ? req.requesterId : req.providerId, other, requestId,
      party === 'REQUESTER' ? 'Quote accepted - shipment booked' : 'Counter-offer accepted - shipment booked',
      `${money(Number(round.totalPrice))} for ${req.pickupCity} → ${req.deliveryCity}. Transport order ${req.orderNumber} (request ${req.requestNumber}). Add the driver and vehicle details before pickup.`);
    await recordAudit(this.prisma, actorId, 'transport_round_accepted', 'transport', requestId, { roundNo: round.roundNo, price: Number(round.totalPrice), orderNumber: req.orderNumber, party });
    return this.getOne(requestId, actorId, 'USER');
  }

  // Reject the CURRENT round proposed by the other side (requester refuses a quote,
  // provider refuses a counter-offer). The request returns to "awaiting quote".
  async rejectRound(requestId: string, actorId: string, reason: string) {
    await this.assertApproved(actorId);
    const pre = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!pre) throw new NotFoundException('Request not found');
    const party = partyOf(pre, actorId);
    if (!party) throw new ForbiddenException('Not your request');
    const why = (reason || '').trim();
    if (why.length < 5) throw new BadRequestException('Give a short reason (at least 5 characters)');

    const done = await this.prisma.$transaction(async (tx) => {
      await this.lockRequest(tx, requestId);
      const req = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!req || req.status !== 'QUOTED') throw new BadRequestException('There is no open quote to reject');
      const current = await tx.transportQuoteRound.findFirst({ where: { requestId, status: 'CURRENT' } });
      if (!current) throw new BadRequestException('There is no open quote to reject');
      if (current.proposerRole === party) throw new BadRequestException("You can't reject your own proposal - revise it instead.");
      await tx.transportQuoteRound.update({
        where: { id: current.id }, data: { status: 'DECLINED', respondedAt: new Date(), respondedById: actorId },
      });
      await tx.transportRequest.update({ where: { id: requestId }, data: { status: 'REQUESTED', ...this.clearMirror } });
      return { req, current };
    });
    const other: Party = party === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
    await this.notifyParty(other === 'REQUESTER' ? done.req.requesterId : done.req.providerId, other, requestId,
      party === 'REQUESTER' ? 'Your quote was declined' : 'Your counter-offer was declined',
      `${done.req.pickupCity} → ${done.req.deliveryCity} (${done.req.requestNumber}): ${why}. You can send a new ${other === 'PROVIDER' ? 'quote' : 'request'}.`);
    await recordAudit(this.prisma, actorId, 'transport_round_declined', 'transport', requestId, { roundNo: done.current.roundNo, party, reason: why });
    return this.getOne(requestId, actorId, 'USER');
  }

  // ─── PROVIDER DECLINES THE WHOLE REQUEST ──────────────────────────────────
  async decline(requestId: string, providerId: string, reason: string) {
    await this.assertApproved(providerId);
    const why = (reason || '').trim();
    if (why.length < 5) throw new BadRequestException('Give the requester a short reason (at least 5 characters)');
    const req = await this.prisma.$transaction(async (tx) => {
      await this.lockRequest(tx, requestId);
      const r = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!r) throw new NotFoundException('Request not found');
      if (r.providerId !== providerId) throw new ForbiddenException('Not your request');
      if (!OPEN_REQUEST_STATES.includes(r.status as any)) throw new BadRequestException('Only requests awaiting a quote or acceptance can be declined');
      await tx.transportQuoteRound.updateMany({
        where: { requestId, status: 'CURRENT' }, data: { status: 'DECLINED', respondedAt: new Date(), respondedById: providerId },
      });
      await tx.transportRequest.update({ where: { id: requestId }, data: { providerId: null, status: 'REQUESTED', ...this.clearMirror } });
      return r;
    });
    await this.notifyParty(req.requesterId, 'REQUESTER', requestId, 'A transporter declined your request',
      `${req.pickupCity} → ${req.deliveryCity} (${refLabel(req)}): ${why}. You can send it to another provider.`);
    await recordAudit(this.prisma, providerId, 'transport_request_declined', 'transport', requestId, { reason: why });
    return { message: 'Request declined' };
  }

  // ─── REQUESTER CANCELS (until pickup) ─────────────────────────────────────
  async cancel(requestId: string, requesterId: string, reason?: string) {
    const req = await this.prisma.$transaction(async (tx) => {
      await this.lockRequest(tx, requestId);
      const r = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!r) throw new NotFoundException('Request not found');
      if (r.requesterId !== requesterId) throw new ForbiddenException('Not your request');
      if (!['REQUESTED', 'QUOTED', 'BOOKED'].includes(r.status)) {
        throw new BadRequestException('This shipment has already been picked up and can no longer be cancelled');
      }
      await tx.transportQuoteRound.updateMany({
        where: { requestId, status: 'CURRENT' }, data: { status: 'WITHDRAWN', respondedAt: new Date(), respondedById: requesterId },
      });
      await tx.transportRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED' } });
      return r;
    });
    await this.notifyParty(req.providerId, 'PROVIDER', requestId, 'Transport request cancelled',
      `${req.pickupCity} → ${req.deliveryCity} (${refLabel(req)}) was cancelled by the requester${reason?.trim() ? `: ${reason.trim()}` : '.'}`);
    await recordAudit(this.prisma, requesterId, 'transport_request_cancelled', 'transport', requestId, { reason: reason?.trim() });
    return { message: 'Request cancelled' };
  }

  // ─── DRIVER + TRACKING (provider) ─────────────────────────────────────────
  async updateTracking(requestId: string, providerId: string, data: TrackingUpdateDto) {
    await this.assertApproved(providerId);
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your shipment');
    // Only a confirmed, live shipment can be tracked - never one still being quoted,
    // already delivered, disputed or cancelled.
    if (!(LIVE_SHIPMENT_STATES as readonly string[]).includes(request.status)) {
      throw new BadRequestException(`Tracking can't be updated while the shipment is ${label(request.status)}`);
    }
    if (data.status && !TransportLifecycleService.TRACKING_NEXT[request.status]?.includes(data.status)) {
      throw new BadRequestException(`A shipment can't move from ${request.status} to ${data.status}`);
    }

    const driverName = data.driverName?.trim() || request.driverName;
    const driverPhone = data.driverPhone?.trim() || request.driverPhone;
    if (data.status === 'PICKED_UP' && (!driverName || !driverPhone)) {
      throw new BadRequestException("Add the driver's name and phone number before marking the shipment as picked up.");
    }

    const receiver = data.receiverName?.trim() || request.deliveryReceiverName;
    if (data.status === 'DELIVERED' && !receiver) {
      throw new BadRequestException('Enter who received the goods before marking the shipment delivered.');
    }
    const updateData: any = {};
    if (data.receiverName) updateData.deliveryReceiverName = data.receiverName.trim();
    if (data.deliveryNote !== undefined) updateData.deliveryNote = data.deliveryNote.trim() || null;
    if (data.deliveredQuantityTons !== undefined) updateData.deliveredQuantityTons = data.deliveredQuantityTons;
    if (data.status) updateData.status = data.status;
    if (data.currentLocation) updateData.currentLocation = data.currentLocation.trim();
    if (data.estimatedArrival) updateData.estimatedArrival = new Date(data.estimatedArrival);
    const driverChanged = (data.driverName && data.driverName.trim() !== request.driverName)
      || (data.driverPhone && data.driverPhone.trim() !== request.driverPhone)
      || (data.vehicleRegNo && data.vehicleRegNo.trim().toUpperCase() !== request.vehicleRegNo);
    if (data.driverName) updateData.driverName = data.driverName.trim();
    if (data.driverPhone) updateData.driverPhone = data.driverPhone.trim();
    if (data.vehicleRegNo) updateData.vehicleRegNo = data.vehicleRegNo.trim().toUpperCase();
    if (driverChanged) updateData.driverUpdatedAt = new Date();
    if (data.status === 'PICKED_UP') updateData.pickedUpAt = new Date();
    if (data.status === 'DELIVERED') updateData.deliveredAt = new Date();

    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, status: request.status },
      data: updateData,
    });
    if (res.count === 0) throw new BadRequestException('This shipment was just updated - refresh and try again');

    const route = `${request.pickupCity} → ${request.deliveryCity} (${refLabel(request)})`;
    if (data.status) {
      await this.notifyParty(request.requesterId, 'REQUESTER', requestId, `Shipment ${label(data.status)}`,
        data.status === 'DELIVERED'
          ? `${route} was delivered. Please check the goods and acknowledge delivery - or raise a dispute if something is wrong.`
          : `${route} is now ${label(data.status)}${data.currentLocation ? ` (${data.currentLocation})` : ''}.`);
    } else if (driverChanged) {
      // name only - the phone number stays in the app, not in a notification
      await this.notifyParty(request.requesterId, 'REQUESTER', requestId, 'Driver details updated',
        `${route}: driver ${driverName || 'assigned'}${data.vehicleRegNo ? `, vehicle ${data.vehicleRegNo.trim().toUpperCase()}` : ''}.`);
    }
    await recordAudit(this.prisma, providerId, 'transport_tracking_updated', 'transport', requestId, {
      status: data.status, driverChanged: !!driverChanged,
    });
    return this.getOne(requestId, providerId, 'USER');
  }

  // ─── DELIVERY ACKNOWLEDGEMENT (requester) ─────────────────────────────────
  async acknowledge(requestId: string, requesterId: string, note?: string) {
    await this.assertApproved(requesterId);
    const req = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.requesterId !== requesterId) throw new ForbiddenException('Only the requester can acknowledge delivery');
    if (req.status === 'COMPLETED') return this.getOne(requestId, requesterId, 'USER'); // idempotent
    if (req.status === 'DISPUTED') throw new BadRequestException('This shipment is under dispute - it can be acknowledged once the dispute is resolved.');
    if (req.status !== 'DELIVERED') throw new BadRequestException('Delivery can only be acknowledged once the transporter has marked the shipment delivered.');
    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, status: 'DELIVERED' as any },
      data: { status: 'COMPLETED', acknowledgedAt: new Date(), acknowledgedById: requesterId, acknowledgementNote: note?.trim() || null },
    });
    if (res.count === 0) throw new BadRequestException('This shipment was just updated - refresh and try again');
    await this.notifyParty(req.providerId, 'PROVIDER', requestId, 'Delivery acknowledged',
      `${req.pickupCity} → ${req.deliveryCity} (${refLabel(req)}): the requester confirmed receipt. You can now invoice this shipment.`);
    await recordAudit(this.prisma, requesterId, 'transport_delivery_acknowledged', 'transport', requestId, { note: note?.trim() });
    return this.getOne(requestId, requesterId, 'USER');
  }

  // ─── READS ────────────────────────────────────────────────────────────────
  async getOne(requestId: string, userId: string, role: string) {
    const r: any = await this.prisma.transportRequest.findUnique({ where: { id: requestId }, include: this.includeFull() });
    if (!r) throw new NotFoundException('Request not found');
    const isStaff = role === 'ADMIN' || role === 'MODERATOR';
    const party = partyOf(r, userId);
    if (!party && !isStaff) throw new ForbiddenException('Access denied');
    await this.expireStale(requestId).catch(() => undefined);
    const fresh: any = await this.prisma.transportRequest.findUnique({ where: { id: requestId }, include: this.includeFull() });
    return shapeRequest(fresh, party ?? 'ADMIN');
  }

  async listMine(userId: string, as: 'requester' | 'provider') {
    const where = as === 'requester' ? { requesterId: userId } : { providerId: userId };
    const rows: any[] = await this.prisma.transportRequest.findMany({ where, include: this.includeFull(), orderBy: { createdAt: 'desc' } });
    // sweep expired rounds, then re-read only the ones that changed
    const now = Date.now();
    const staleIds = rows
      .filter((r) => r.status === 'QUOTED' && (r.quoteRounds || []).some((q: any) => q.status === 'CURRENT' && q.expiresAt && new Date(q.expiresAt).getTime() < now))
      .map((r) => r.id);
    for (const id of staleIds) await this.expireStale(id).catch(() => undefined);
    const fresh: any[] = staleIds.length
      ? await this.prisma.transportRequest.findMany({ where, include: this.includeFull(), orderBy: { createdAt: 'desc' } })
      : rows;
    return fresh.map((r) => shapeRequest(r, as === 'requester' ? 'REQUESTER' : 'PROVIDER'));
  }

  // Public, no login (D4): nothing here identifies the driver beyond a masked name.
  async track(requestId: string) {
    const r = await this.prisma.transportRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true, requestNumber: true, status: true, statusBeforeDispute: true, currentLocation: true, estimatedArrival: true,
        driverName: true, pickupCity: true, deliveryCity: true, pickedUpAt: true, deliveredAt: true, trackingUrl: true, vehicleType: true,
      },
    });
    if (!r) throw new NotFoundException('Shipment not found');
    return shapePublicTracking(r);
  }
}
