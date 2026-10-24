// ─── TRANSPORT DISPUTE SERVICE (Phase 3) ──────────────────────────────────────
// Either party can dispute a DELIVERED shipment (or a COMPLETED one within
// DISPUTE_WINDOW_DAYS of acknowledgement). While a dispute is OPEN / RESPONDED the
// shipment is DISPUTED (no acknowledgement, no payment submission). The raiser can
// withdraw; otherwise an admin resolves it. Either way the shipment returns to the
// status it had before (statusBeforeDispute).
//   OPEN --other party responds--> RESPONDED --admin resolves--> RESOLVED
//   OPEN | RESPONDED --raiser withdraws--> WITHDRAWN        (admin may resolve from OPEN too)
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { IsString, IsOptional, IsNumber, IsPositive, IsIn, MinLength, MaxLength, Max } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { destination } from '../notifications/destinations';
import { recordAudit } from '../common/utils/audit.util';
import { formatDocumentNumber } from '../common/utils/document-number.util';
import { DISPUTE_WINDOW_DAYS, Party, money, partyOf, shapeDispute } from './transport.shared';

export const DISPUTE_CATEGORIES = ['DAMAGED_CARGO', 'SHORTAGE', 'LATE_DELIVERY', 'NOT_DELIVERED', 'PRICE_MISMATCH', 'OTHER'] as const;

export class RaiseDisputeDto {
  @IsIn(DISPUTE_CATEGORIES as unknown as string[]) category: (typeof DISPUTE_CATEGORIES)[number];
  @IsString() @MinLength(10) @MaxLength(2000) description: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(1_000_000_000) claimAmount?: number;
  clientRequestId?: string;
}
export class DisputeResponseDto {
  @IsString() @MinLength(5) @MaxLength(2000) response: string;
}
export class ResolveDisputeDto {
  @IsIn(['FAVOUR_REQUESTER', 'FAVOUR_PROVIDER', 'SETTLED']) outcome: 'FAVOUR_REQUESTER' | 'FAVOUR_PROVIDER' | 'SETTLED';
  @IsString() @MinLength(5) @MaxLength(2000) note: string;
}

@Injectable()
export class TransportDisputeService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  private async assertApproved(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } });
    if (!u || u.kycStatus !== 'APPROVED') throw new ForbiddenException('Your account must be fully approved before you can do this.');
  }
  private async lock(tx: any, id: string) { await tx.$queryRaw`SELECT "id" FROM "transport_requests" WHERE "id" = ${id} FOR UPDATE`; }
  private dest(party: Party, requestId: string) {
    return party === 'REQUESTER'
      ? destination('/buyer', { tab: 'transport', entityType: 'transport', entityId: requestId })
      : destination('/transport-portal', { entityType: 'transport', entityId: requestId });
  }
  private async tell(userId: string | null | undefined, party: Party, requestId: string, title: string, body: string) {
    if (userId) await this.notifications.notify({ userId, type: NotificationType.TRANSPORT_UPDATE, title, body, data: this.dest(party, requestId) });
  }

  async raise(requestId: string, actorId: string, dto: RaiseDisputeDto) {
    await this.assertApproved(actorId);
    const pre = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!pre) throw new NotFoundException('Shipment not found');
    const party = partyOf(pre, actorId);
    if (!party) throw new ForbiddenException('Not your shipment');
    if (dto.clientRequestId) {
      const replay = await this.prisma.transportDispute.findFirst({ where: { requestId, clientRequestId: dto.clientRequestId } });
      if (replay) return this.get(replay.id, actorId, 'USER');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, requestId);
      const req = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new NotFoundException('Shipment not found');
      if (req.status === 'DISPUTED') throw new BadRequestException('This shipment already has an open dispute.');
      if (req.status === 'COMPLETED') {
        const ackAt = req.acknowledgedAt?.getTime() ?? 0;
        if (Date.now() - ackAt > DISPUTE_WINDOW_DAYS * 86_400_000) {
          throw new BadRequestException(`The ${DISPUTE_WINDOW_DAYS}-day window to dispute this delivery has closed.`);
        }
      } else if (req.status !== 'DELIVERED') {
        throw new BadRequestException('A dispute can only be raised once the shipment has been delivered.');
      }
      const row = await tx.transportDispute.create({
        data: {
          disputeNumber: `TMP-${Math.random().toString(36).slice(2)}`, requestId, raisedById: actorId, raisedByRole: party,
          category: dto.category, description: dto.description.trim(), claimAmount: dto.claimAmount ?? null,
          clientRequestId: dto.clientRequestId || null,
        },
      });
      const dispute = await tx.transportDispute.update({
        where: { id: row.id }, data: { disputeNumber: formatDocumentNumber('TDS', row.disputeSeq, row.createdAt) },
      });
      await tx.transportRequest.update({ where: { id: requestId }, data: { status: 'DISPUTED', statusBeforeDispute: req.status } });
      return { dispute, req, replay: false };
    }).catch(async (err: any) => {
      if (err?.code === 'P2002') {
        if (dto.clientRequestId) {
          const replay = await this.prisma.transportDispute.findFirst({ where: { requestId, clientRequestId: dto.clientRequestId } });
          if (replay) return { dispute: replay, req: pre, replay: true };
        }
        throw new BadRequestException('This shipment already has an open dispute.');
      }
      throw err;
    });

    if (!created.replay) {
      const other: Party = party === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
      const { req, dispute } = created;
      await this.tell(other === 'REQUESTER' ? req.requesterId : req.providerId, other, requestId,
        `Dispute ${dispute.disputeNumber} raised`,
        `${req.pickupCity} → ${req.deliveryCity} (${req.requestNumber}): ${dto.category.toLowerCase().replace(/_/g, ' ')}${dto.claimAmount ? `, claim ${money(dto.claimAmount)}` : ''}. Please respond.`);
      await recordAudit(this.prisma, actorId, 'transport_dispute_raised', 'transport', requestId, { disputeId: dispute.id, category: dto.category, party });
    }
    return this.get(created.dispute.id, actorId, 'USER');
  }

  async respond(disputeId: string, actorId: string, response: string) {
    await this.assertApproved(actorId);
    const d = await this.prisma.transportDispute.findUnique({ where: { id: disputeId }, include: { request: true } });
    if (!d) throw new NotFoundException('Dispute not found');
    const party = partyOf(d.request, actorId);
    if (!party) throw new ForbiddenException('Not your shipment');
    if (party === d.raisedByRole) throw new ForbiddenException('The other party answers a dispute you raised.');
    const res = await this.prisma.transportDispute.updateMany({
      where: { id: disputeId, status: 'OPEN' },
      data: { status: 'RESPONDED', response: response.trim(), respondedAt: new Date(), respondedById: actorId },
    });
    if (res.count === 0) throw new BadRequestException('This dispute is no longer waiting for a response.');
    const raiser: Party = d.raisedByRole as Party;
    await this.tell(d.raisedById, raiser, d.requestId, `Response to dispute ${d.disputeNumber}`,
      `${d.request.requestNumber}: the other party responded. An admin will review if you cannot agree - you can also withdraw it.`);
    await recordAudit(this.prisma, actorId, 'transport_dispute_responded', 'transport', d.requestId, { disputeId });
    return this.get(disputeId, actorId, 'USER');
  }

  async withdraw(disputeId: string, actorId: string) {
    const d = await this.prisma.transportDispute.findUnique({ where: { id: disputeId }, include: { request: true } });
    if (!d) throw new NotFoundException('Dispute not found');
    if (d.raisedById !== actorId) throw new ForbiddenException('Only the person who raised the dispute can withdraw it.');
    await this.close(d, 'WITHDRAWN', actorId, {});
    const other: Party = d.raisedByRole === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER';
    await this.tell(other === 'REQUESTER' ? d.request.requesterId : d.request.providerId, other, d.requestId,
      `Dispute ${d.disputeNumber} withdrawn`, `${d.request.requestNumber}: the dispute was withdrawn.`);
    await recordAudit(this.prisma, actorId, 'transport_dispute_withdrawn', 'transport', d.requestId, { disputeId });
    return this.get(disputeId, actorId, 'USER');
  }

  async resolve(disputeId: string, adminId: string, dto: ResolveDisputeDto) {
    const d = await this.prisma.transportDispute.findUnique({ where: { id: disputeId }, include: { request: true } });
    if (!d) throw new NotFoundException('Dispute not found');
    await this.close(d, 'RESOLVED', adminId, { resolutionOutcome: dto.outcome, resolutionNote: dto.note.trim(), resolvedAt: new Date(), resolvedById: adminId });
    const text = `${d.request.requestNumber}: dispute ${d.disputeNumber} was resolved (${dto.outcome.toLowerCase().replace(/_/g, ' ')}). ${dto.note.trim()}`;
    await this.tell(d.request.requesterId, 'REQUESTER', d.requestId, `Dispute ${d.disputeNumber} resolved`, text);
    await this.tell(d.request.providerId, 'PROVIDER', d.requestId, `Dispute ${d.disputeNumber} resolved`, text);
    await recordAudit(this.prisma, adminId, 'transport_dispute_resolved', 'transport', d.requestId, { disputeId, outcome: dto.outcome });
    return this.get(disputeId, adminId, 'ADMIN');
  }

  // Close an open dispute and unfreeze the shipment, atomically.
  private async close(d: any, status: 'WITHDRAWN' | 'RESOLVED', actorId: string, extra: Record<string, any>) {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, d.requestId);
      const res = await tx.transportDispute.updateMany({
        where: { id: d.id, status: { in: ['OPEN', 'RESPONDED'] as any } },
        data: { status, ...(status === 'WITHDRAWN' ? { withdrawnAt: new Date() } : {}), ...extra },
      });
      if (res.count === 0) throw new BadRequestException('This dispute is already closed.');
      const req = await tx.transportRequest.findUnique({ where: { id: d.requestId } });
      if (req?.status === 'DISPUTED') {
        await tx.transportRequest.update({ where: { id: d.requestId }, data: { status: req.statusBeforeDispute || 'DELIVERED', statusBeforeDispute: null } });
      }
    });
  }

  // ─── READS ────────────────────────────────────────────────────────────────
  async get(disputeId: string, userId: string, role: string) {
    const d: any = await this.prisma.transportDispute.findUnique({ where: { id: disputeId }, include: { request: true } });
    if (!d) throw new NotFoundException('Dispute not found');
    const isStaff = role === 'ADMIN' || role === 'MODERATOR';
    const party = partyOf(d.request, userId);
    if (!party && !isStaff) throw new ForbiddenException('Access denied');
    return shapeDispute(d, party ?? 'ADMIN');
  }

  async listMine(userId: string) {
    const rows: any[] = await this.prisma.transportDispute.findMany({
      where: { OR: [{ request: { requesterId: userId } }, { request: { providerId: userId } }] },
      include: { request: true }, orderBy: { createdAt: 'desc' },
    });
    return rows.map((d) => shapeDispute(d, d.request.requesterId === userId ? 'REQUESTER' : 'PROVIDER'));
  }

  // Admin queue: every dispute, open ones first.
  async adminList(status?: string) {
    const rows: any[] = await this.prisma.transportDispute.findMany({
      where: status ? { status: status as any } : {},
      include: { request: { select: { requestNumber: true, pickupCity: true, deliveryCity: true, agreedPrice: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const rank = (s: string) => (s === 'OPEN' ? 0 : s === 'RESPONDED' ? 1 : 2);
    return rows
      .map((d) => ({ ...shapeDispute(d, 'ADMIN'), requestRef: d.request.requestNumber, route: `${d.request.pickupCity} → ${d.request.deliveryCity}`, agreedPrice: d.request.agreedPrice != null ? Number(d.request.agreedPrice) : null }))
      .sort((a, b) => rank(a.status) - rank(b.status));
  }
}
