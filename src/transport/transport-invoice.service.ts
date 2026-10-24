// ─── TRANSPORT INVOICE SERVICE (Phase 3) ──────────────────────────────────────
// The provider invoices the requester for a delivered shipment.
//  * The amount is the AGREED price of the accepted round - never client supplied.
//  * No platform fee on transport (none is defined), so nothing is redacted per viewer.
//  * Issuable once the shipment is DELIVERED / COMPLETED (or DISPUTED after delivery).
//  * At most one non-VOID invoice per shipment (row lock here + partial unique index).
//  * ISSUED -> PAYMENT_SUBMITTED (requester) -> PAYMENT_CONFIRMED (provider) | VOID;
//    the provider may send a submitted payment back to ISSUED ("not received").
//  * The requester cannot submit payment while the shipment is under dispute.
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotificationType } from '@prisma/client';
import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { destination } from '../notifications/destinations';
import { recordAudit } from '../common/utils/audit.util';
import { formatDocumentNumber } from '../common/utils/document-number.util';
import { renderPdfDocument } from '../common/pdf/pdf.util';
import { money } from './transport.shared';
import { computeSchedule, finalDueDate, describeTerms, contextFromOrder } from '../offers/terms/payment-terms';

export class SubmitTransportPaymentDto {
  @IsString() @MinLength(3) @MaxLength(100) reference: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class InvoiceReasonDto {
  @IsString() @MinLength(5) @MaxLength(500) reason: string;
}

const ISSUABLE = ['DELIVERED', 'COMPLETED', 'DISPUTED'];
const VOIDABLE = ['ISSUED', 'PAYMENT_SUBMITTED'];

@Injectable()
export class TransportInvoiceService {
  constructor(private prisma: PrismaService, private storage: StorageService, private notifications: NotificationsService) {}

  private async assertApproved(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } });
    if (!u || u.kycStatus !== 'APPROVED') throw new ForbiddenException('Your account must be fully approved before you can do this.');
  }

  private toRequester(requestId: string) { return destination('/buyer', { tab: 'transport', entityType: 'transport', entityId: requestId }); }
  private toProvider(requestId: string) { return destination('/transport-portal', { entityType: 'transport', entityId: requestId }); }

  // ─── ISSUE ────────────────────────────────────────────────────────────────
  async issue(providerId: string, requestId: string, opts: { replacesId?: string } = {}) {
    await this.assertApproved(providerId);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "transport_requests" WHERE "id" = ${requestId} FOR UPDATE`;
      const req = await tx.transportRequest.findUnique({ where: { id: requestId } });
      if (!req) throw new NotFoundException('Shipment not found');
      if (req.providerId !== providerId) throw new ForbiddenException('Only the transporter of this shipment can invoice it');
      if (!ISSUABLE.includes(req.status)) throw new BadRequestException(`An invoice can only be issued after delivery (this shipment is ${req.status.toLowerCase().replace(/_/g, ' ')}).`);
      if (req.agreedPrice == null) throw new BadRequestException('This shipment has no agreed price to invoice.');

      const live = await tx.transportInvoice.findFirst({ where: { requestId, status: { not: 'VOID' } }, select: { id: true, invoiceNumber: true } });
      if (live) throw new BadRequestException(`This shipment already has an active invoice (${live.invoiceNumber}). Void it first if it needs to be replaced.`);

      let version = 1;
      if (opts.replacesId) {
        const prev = await tx.transportInvoice.findUnique({ where: { id: opts.replacesId } });
        if (!prev || prev.requestId !== requestId) throw new BadRequestException('The invoice being replaced does not belong to this shipment');
        if (prev.status !== 'VOID') throw new BadRequestException('Only a voided invoice can be replaced');
        version = prev.version + 1;
      }
      const issuedAt = new Date();
      // Due date comes from the payment terms agreed on the accepted quote (snapshot), not a fixed 7 days.
      const terms = (req.paymentTermsSnapshot ?? null) as any;
      const schedule = computeSchedule(terms, Number(req.agreedPrice), {
        confirmedAt: req.orderConfirmedAt, deliveredAt: req.deliveredAt, acknowledgedAt: req.acknowledgedAt, invoiceDate: issuedAt,
      });
      const dueDate = finalDueDate(schedule); // null = open-ended (e.g. credit counted from an acknowledgement that has not happened)
      const row = await tx.transportInvoice.create({
        data: {
          invoiceNumber: `TMP-${randomUUID()}`, requestId, providerId, requesterId: req.requesterId, version, replacesId: opts.replacesId ?? null,
          amount: req.agreedPrice,
          description: `Transport ${req.pickupCity} → ${req.deliveryCity} (${req.requestNumber})${req.cargoDescription ? ` - ${req.cargoDescription}` : ''}`,
          orderNumber: req.orderNumber ?? null, paymentTermsSnapshot: terms, dueDate, issuedAt,
        },
      });
      return tx.transportInvoice.update({ where: { id: row.id }, data: { invoiceNumber: formatDocumentNumber('TINV', row.invoiceSeq, row.issuedAt) } });
    });

    await this.ensurePdf(created.id).catch(() => undefined);
    await this.notifications.notify({
      userId: created.requesterId, type: NotificationType.PAYMENT_DUE,
      title: `Transport invoice ${created.invoiceNumber} received`,
      body: `The transporter invoiced ${money(Number(created.amount))} for transport order ${created.orderNumber ?? ''}. ${created.dueDate ? `Due ${created.dueDate.toLocaleDateString('en-GB')}.` : `Payment: ${describeTerms(created.paymentTermsSnapshot as any)}.`}`,
      data: this.toRequester(requestId),
    });
    await recordAudit(this.prisma, providerId, 'transport_invoice_issued', 'transport', requestId, {
      invoiceId: created.id, invoiceNumber: created.invoiceNumber, version: created.version, replacesId: opts.replacesId,
    });
    return this.get(created.id, providerId, 'USER');
  }

  async replace(invoiceId: string, providerId: string, reason: string) {
    const inv = await this.prisma.transportInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.providerId !== providerId) throw new ForbiddenException('Not your invoice');
    await this.void(invoiceId, providerId, 'USER', reason);
    return this.issue(providerId, inv.requestId, { replacesId: invoiceId });
  }

  // ─── PAYMENT FLOW ─────────────────────────────────────────────────────────
  async submitPayment(invoiceId: string, requesterId: string, dto: SubmitTransportPaymentDto) {
    await this.assertApproved(requesterId);
    const inv = await this.prisma.transportInvoice.findUnique({ where: { id: invoiceId }, include: { request: { select: { status: true } } } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.requesterId !== requesterId) throw new ForbiddenException('This invoice was not issued to you');
    if (inv.request.status === 'DISPUTED') throw new BadRequestException('This shipment is under dispute. Payment can be submitted once the dispute is resolved.');
    const res = await this.prisma.transportInvoice.updateMany({
      where: { id: invoiceId, status: 'ISSUED' },
      data: {
        status: 'PAYMENT_SUBMITTED', paymentReference: dto.reference.trim(), paymentNote: dto.note?.trim() || null,
        paymentSubmittedAt: new Date(), paymentSubmittedById: requesterId, paymentRejectedNote: null,
      },
    });
    if (res.count === 0) throw new BadRequestException(`Payment can only be submitted on an open invoice (this one is ${inv.status.toLowerCase().replace(/_/g, ' ')}).`);
    await this.notifications.notify({
      userId: inv.providerId, type: NotificationType.PAYMENT_RECEIVED,
      title: `Payment submitted for ${inv.invoiceNumber}`,
      body: `The requester says they paid (reference ${dto.reference.trim()}). Check your account and confirm the payment.`,
      data: this.toProvider(inv.requestId),
    });
    await recordAudit(this.prisma, requesterId, 'transport_invoice_payment_submitted', 'transport', inv.requestId, { invoiceId, reference: dto.reference });
    return this.get(invoiceId, requesterId, 'USER');
  }

  async confirmPayment(invoiceId: string, actorId: string, actorRole: string) {
    await this.assertApproved(actorId);
    const inv = await this.prisma.transportInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const isAdmin = actorRole === 'ADMIN';
    if (inv.providerId !== actorId && !isAdmin) throw new ForbiddenException('Only the transporter can confirm payment');
    const res = await this.prisma.transportInvoice.updateMany({
      where: { id: invoiceId, status: 'PAYMENT_SUBMITTED' },
      data: { status: 'PAYMENT_CONFIRMED', paymentConfirmedAt: new Date(), paymentConfirmedById: actorId },
    });
    if (res.count === 0) throw new BadRequestException('Only an invoice with a submitted payment can be confirmed.');
    await this.notifications.notify({
      userId: inv.requesterId, type: NotificationType.PAYMENT_RECEIVED,
      title: `Payment confirmed for ${inv.invoiceNumber}`, body: `The transporter confirmed your payment of ${money(Number(inv.amount))}.`,
      data: this.toRequester(inv.requestId),
    });
    await recordAudit(this.prisma, actorId, 'transport_invoice_payment_confirmed', 'transport', inv.requestId, { invoiceId });
    return this.get(invoiceId, actorId, isAdmin ? 'ADMIN' : 'USER');
  }

  async rejectPayment(invoiceId: string, providerId: string, reason: string) {
    await this.assertApproved(providerId);
    const inv = await this.prisma.transportInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.providerId !== providerId) throw new ForbiddenException('Only the transporter can do this');
    const res = await this.prisma.transportInvoice.updateMany({
      where: { id: invoiceId, status: 'PAYMENT_SUBMITTED' },
      data: { status: 'ISSUED', paymentRejectedNote: reason.trim(), paymentSubmittedAt: null, paymentSubmittedById: null },
    });
    if (res.count === 0) throw new BadRequestException('There is no submitted payment to send back on this invoice.');
    await this.notifications.notify({
      userId: inv.requesterId, type: NotificationType.PAYMENT_DUE,
      title: `Payment not received for ${inv.invoiceNumber}`, body: `The transporter could not match your payment: ${reason.trim()}. Please check and submit again.`,
      data: this.toRequester(inv.requestId),
    });
    await recordAudit(this.prisma, providerId, 'transport_invoice_payment_rejected', 'transport', inv.requestId, { invoiceId, reason });
    return this.get(invoiceId, providerId, 'USER');
  }

  async void(invoiceId: string, actorId: string, actorRole: string, reason: string) {
    const inv = await this.prisma.transportInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const isAdmin = actorRole === 'ADMIN';
    if (inv.providerId !== actorId && !isAdmin) throw new ForbiddenException('Only the transporter can void this invoice');
    const res = await this.prisma.transportInvoice.updateMany({
      where: { id: invoiceId, status: { in: VOIDABLE as any } },
      data: { status: 'VOID', voidedAt: new Date(), voidedById: actorId, voidReason: reason.trim() },
    });
    if (res.count === 0) throw new BadRequestException(inv.status === 'VOID' ? 'This invoice is already void.' : 'A confirmed invoice cannot be voided.');
    await this.notifications.notify({
      userId: inv.requesterId, type: NotificationType.PAYMENT_DUE,
      title: `Invoice ${inv.invoiceNumber} was voided`, body: `Reason: ${reason.trim()}. A corrected invoice may follow.`,
      data: this.toRequester(inv.requestId),
    });
    await recordAudit(this.prisma, actorId, 'transport_invoice_voided', 'transport', inv.requestId, { invoiceId, reason });
    return this.get(invoiceId, actorId, isAdmin ? 'ADMIN' : 'USER');
  }

  // ─── PDF ──────────────────────────────────────────────────────────────────
  private async ensurePdf(invoiceId: string): Promise<string> {
    const inv: any = await this.prisma.transportInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        request: true,
        provider: { select: { profile: { select: { fullName: true, businessName: true, address: true, city: true } }, transportProfile: { select: { companyName: true } } } },
        requester: { select: { profile: { select: { fullName: true, businessName: true, address: true, city: true } } } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.s3Key) return inv.s3Key;
    const pp = inv.provider?.profile; const rp = inv.requester?.profile;
    const r = inv.request;
    const pdf = await renderPdfDocument({
      documentTitle: 'TRANSPORT INVOICE',
      documentNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt,
      fromLines: [inv.provider?.transportProfile?.companyName || pp?.businessName || pp?.fullName || 'Transporter', pp?.address || '', pp?.city || ''].filter(Boolean),
      toLines: [rp?.businessName || rp?.fullName || 'Requester', rp?.address || '', rp?.city || ''].filter(Boolean),
      meta: [
        ['Transport order', inv.orderNumber || r.orderNumber || '-'],
        ['Request ref', r.requestNumber],
        ['Payment terms', describeTerms((inv.paymentTermsSnapshot ?? r.paymentTermsSnapshot) as any)],
        ['Route', `${r.pickupCity} → ${r.deliveryCity}`],
        ['Due date', inv.dueDate ? inv.dueDate.toLocaleDateString('en-GB') : 'Per payment terms'],
        ...(inv.version > 1 ? [['Version', `${inv.version} (replaces an earlier invoice)`] as [string, string]] : []),
      ],
      lineItems: [{ label: inv.description, amount: Number(inv.amount) }],
      totalLabel: 'TOTAL AMOUNT DUE',
      totalAmount: Number(inv.amount),
      footerNote: 'Pay the transporter directly and submit your payment reference on AgriConnect. The transporter confirms receipt. This is not a receipt of payment.',
    });
    const key = `transport-invoices/${inv.id}.pdf`;
    await this.storage.putObject(key, pdf, 'application/pdf');
    await this.prisma.transportInvoice.update({ where: { id: inv.id }, data: { s3Key: key } });
    return key;
  }

  // ─── READS ────────────────────────────────────────────────────────────────
  private shape(inv: any) {
    const { s3Key, request, provider, requester, ...rest } = inv;
    return {
      ...rest, amount: Number(inv.amount),
      requestRef: request?.requestNumber, route: request ? `${request.pickupCity} → ${request.deliveryCity}` : undefined,
      shipmentStatus: request?.status,
      providerName: provider?.transportProfile?.companyName || provider?.profile?.businessName || provider?.profile?.fullName,
      requesterName: requester?.profile?.businessName || requester?.profile?.fullName,
    };
  }

  private includeView() {
    return {
      request: { select: { requestNumber: true, pickupCity: true, deliveryCity: true, status: true } },
      provider: { select: { profile: { select: { fullName: true, businessName: true } }, transportProfile: { select: { companyName: true } } } },
      requester: { select: { profile: { select: { fullName: true, businessName: true } } } },
    };
  }

  async get(invoiceId: string, userId: string, role: string) {
    const inv: any = await this.prisma.transportInvoice.findUnique({ where: { id: invoiceId }, include: this.includeView() });
    if (!inv) throw new NotFoundException('Invoice not found');
    const isAdmin = role === 'ADMIN' || role === 'MODERATOR';
    if (inv.providerId !== userId && inv.requesterId !== userId && !isAdmin) throw new ForbiddenException('Access denied');
    let downloadUrl: string | null = null;
    if (inv.status !== 'VOID') {
      try { downloadUrl = await this.storage.getPresignedUrl(inv.s3Key || (await this.ensurePdf(inv.id)), 600); } catch { downloadUrl = null; }
    }
    return { ...this.shape(inv), downloadUrl };
  }

  async listMine(userId: string, as: 'requester' | 'provider') {
    const rows: any[] = await this.prisma.transportInvoice.findMany({
      where: as === 'provider' ? { providerId: userId } : { requesterId: userId },
      include: this.includeView(), orderBy: { issuedAt: 'desc' },
    });
    return rows.map((r) => this.shape(r));
  }

  async forRequest(requestId: string, userId: string, role: string) {
    const req = await this.prisma.transportRequest.findUnique({ where: { id: requestId }, select: { requesterId: true, providerId: true } });
    if (!req) throw new NotFoundException('Shipment not found');
    const isAdmin = role === 'ADMIN' || role === 'MODERATOR';
    if (req.requesterId !== userId && req.providerId !== userId && !isAdmin) throw new ForbiddenException('Access denied');
    const rows: any[] = await this.prisma.transportInvoice.findMany({ where: { requestId }, include: this.includeView(), orderBy: { issuedAt: 'desc' } });
    return rows.map((r) => this.shape(r));
  }
}
