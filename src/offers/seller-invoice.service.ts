// ─── SELLER INVOICE SERVICE (Phase 2) ─────────────────────────────────────────
// A seller invoices the buyer for an order. Rules:
//  * D5: the buyer owes the FULL order amount. Platform fee % / fee / seller net
//    are a separate seller-side section: stored on the row, returned only to the
//    seller (and admins), never printed on the buyer's PDF nor sent to the buyer.
//  * At most one non-VOID invoice per order (order row lock here + partial unique
//    index in the SQL migration). A wrong invoice is VOIDed and replaced (version+1).
//  * ISSUED -> PAYMENT_SUBMITTED (buyer) -> PAYMENT_CONFIRMED (seller) | VOID.
//    The seller may send a submitted payment back to ISSUED ("not received").
//  * Due dates follow the order's immutable terms snapshot; they are recomputed
//    live from the order history (credit starts at delivery acknowledgement, D3).
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotificationType, OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { destination } from '../notifications/destinations';
import { recordAudit } from '../common/utils/audit.util';
import { formatDocumentNumber } from '../common/utils/document-number.util';
import { renderPdfDocument, PdfLineItem } from '../common/pdf/pdf.util';
import {
  IsString, IsOptional, MinLength, MaxLength,
} from 'class-validator';
import {
  PaymentTerms,
  computeSchedule,
  contextFromOrder,
  describeTerms,
  finalDueDate,
  normalizePaymentTerms,
  ScheduleItem,
} from './terms/payment-terms';

export class SubmitPaymentDto {
  @IsString() @MinLength(3) @MaxLength(100)
  reference: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class ReasonDto {
  @IsString() @MinLength(5) @MaxLength(500)
  reason: string;
}

const ISSUABLE: OrderStatus[] = [OrderStatus.CONFIRMED, OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED, OrderStatus.COMPLETED];
const VOIDABLE = ['ISSUED', 'PAYMENT_SUBMITTED'];
const money = (n: number) => `₨${Number(n).toLocaleString()}`;

@Injectable()
export class SellerInvoiceService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private notifications: NotificationsService,
  ) {}

  private async assertApproved(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } });
    if (!u || u.kycStatus !== 'APPROVED') throw new ForbiddenException('Your account must be fully approved before you can do this.');
  }

  // ─── ISSUE ────────────────────────────────────────────────────────────────
  async issue(sellerId: string, orderId: string, opts: { replacesId?: string } = {}) {
    await this.assertApproved(sellerId);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { offer: { include: { product: { select: { name: true, unit: true } } } }, statusHistory: true },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.sellerId !== sellerId) throw new ForbiddenException('Only the seller of this order can invoice it');
      if (!ISSUABLE.includes(order.status)) throw new BadRequestException(`An invoice cannot be issued for an order that is ${order.status.toLowerCase()}.`);

      const live = await tx.sellerInvoice.findFirst({ where: { orderId, status: { not: 'VOID' } }, select: { id: true, invoiceNumber: true } });
      if (live) throw new BadRequestException(`This order already has an active invoice (${live.invoiceNumber}). Void it first if it needs to be replaced.`);

      let version = 1;
      if (opts.replacesId) {
        const prev = await tx.sellerInvoice.findUnique({ where: { id: opts.replacesId } });
        if (!prev || prev.orderId !== orderId) throw new BadRequestException('The invoice being replaced does not belong to this order');
        if (prev.status !== 'VOID') throw new BadRequestException('Only a voided invoice can be replaced');
        version = prev.version + 1;
      }

      const rawSnapshot = order.paymentTermsSnapshot;
const snapshot: PaymentTerms | null =
  rawSnapshot == null ? null : normalizePaymentTerms(rawSnapshot);
      const issuedAt = new Date();
      const total = Number(order.totalAmount);
      const unitPrice = Number(order.unitPrice ?? (order.quantity ? total / order.quantity : 0));
      const quantity = order.quantity ?? order.offer.quantity;
      const schedule = computeSchedule(snapshot, total, contextFromOrder(order as any, issuedAt));

      const row = await tx.sellerInvoice.create({
        data: {
          invoiceNumber: `TMP-${randomUUID()}`,
          orderId, sellerId, buyerId: order.buyerId, version, replacesId: opts.replacesId ?? null,
          orderAmount: total, unitPrice, quantity,
          itemDescription: `${order.offer.product.name} - ${quantity} ${order.offer.product.unit} @ ${money(unitPrice)}`,
          platformFeePct: order.platformFeePct, platformFee: order.platformFee, sellerNet: order.netSellerAmount,
          paymentTermsSnapshot: snapshot as any,
          schedule: schedule as any,
          dueDate: finalDueDate(schedule),
          issuedAt,
        },
      });
      return tx.sellerInvoice.update({
        where: { id: row.id },
        data: { invoiceNumber: formatDocumentNumber('SINV', row.invoiceSeq, row.issuedAt) },
      });
    });

    await this.ensurePdf(created.id).catch(() => undefined); // best effort; regenerated lazily on view
    await this.notifications.notify({
      userId: created.buyerId,
      type: NotificationType.PAYMENT_DUE,
      title: `Invoice ${created.invoiceNumber} received`,
      body: `The seller issued an invoice for ${money(Number(created.orderAmount))}. Terms: ${describeTerms(created.paymentTermsSnapshot as any)}.`,
      data: destination('/buyer', { tab: 'orders', entityType: 'invoice', entityId: created.id }),
    });
    await recordAudit(this.prisma, sellerId, 'seller_invoice_issued', 'invoice', created.id, {
      orderId, invoiceNumber: created.invoiceNumber, version: created.version, replacesId: opts.replacesId,
    });
    return this.get(created.id, sellerId, 'SELLER');
  }

  // Void the current invoice and issue a corrected one (new number, version+1).
  async replace(invoiceId: string, sellerId: string, reason: string) {
    const inv = await this.prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.sellerId !== sellerId) throw new ForbiddenException('Not your invoice');
    await this.void(invoiceId, sellerId, 'SELLER', reason);
    return this.issue(sellerId, inv.orderId, { replacesId: invoiceId });
  }

  // ─── PAYMENT FLOW ─────────────────────────────────────────────────────────
  async submitPayment(invoiceId: string, buyerId: string, dto: SubmitPaymentDto) {
    await this.assertApproved(buyerId);
    const inv = await this.prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.buyerId !== buyerId) throw new ForbiddenException('This invoice was not issued to you');
    const res = await this.prisma.sellerInvoice.updateMany({
      where: { id: invoiceId, status: 'ISSUED' },
      data: {
        status: 'PAYMENT_SUBMITTED', paymentReference: dto.reference.trim(), paymentNote: dto.note?.trim() || null,
        paymentSubmittedAt: new Date(), paymentSubmittedById: buyerId, paymentRejectedNote: null,
      },
    });
    if (res.count === 0) throw new BadRequestException(`Payment can only be submitted on an open invoice (this one is ${inv.status.toLowerCase().replace('_', ' ')}).`);
    await this.notifications.notify({
      userId: inv.sellerId,
      type: NotificationType.PAYMENT_RECEIVED,
      title: `Payment submitted for ${inv.invoiceNumber}`,
      body: `The buyer says they paid (reference ${dto.reference.trim()}). Check your account and confirm the payment.`,
      data: destination('/seller', { tab: 'orders', entityType: 'invoice', entityId: invoiceId }),
    });
    await recordAudit(this.prisma, buyerId, 'seller_invoice_payment_submitted', 'invoice', invoiceId, { reference: dto.reference });
    return this.get(invoiceId, buyerId, 'BUYER');
  }

  async confirmPayment(invoiceId: string, actorId: string, actorRole: string) {
    await this.assertApproved(actorId);
    const inv = await this.prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const isAdmin = actorRole === 'ADMIN';
    if (inv.sellerId !== actorId && !isAdmin) throw new ForbiddenException('Only the seller can confirm payment');
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.sellerInvoice.updateMany({
        where: { id: invoiceId, status: 'PAYMENT_SUBMITTED' },
        data: { status: 'PAYMENT_CONFIRMED', paymentConfirmedAt: new Date(), paymentConfirmedById: actorId },
      });
      if (res.count === 0) throw new BadRequestException('Only an invoice with a submitted payment can be confirmed.');
      await tx.order.updateMany({ where: { id: inv.orderId }, data: { paymentStatus: PaymentStatus.PAID } });
    });
    await this.notifications.notify({
      userId: inv.buyerId,
      type: NotificationType.PAYMENT_RECEIVED,
      title: `Payment confirmed for ${inv.invoiceNumber}`,
      body: `The seller confirmed your payment of ${money(Number(inv.orderAmount))}.`,
      data: destination('/buyer', { tab: 'orders', entityType: 'invoice', entityId: invoiceId }),
    });
    await recordAudit(this.prisma, actorId, 'seller_invoice_payment_confirmed', 'invoice', invoiceId, { orderId: inv.orderId });
    return this.get(invoiceId, actorId, isAdmin ? 'ADMIN' : 'SELLER');
  }

  async rejectPayment(invoiceId: string, sellerId: string, reason: string) {
    await this.assertApproved(sellerId);
    const inv = await this.prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.sellerId !== sellerId) throw new ForbiddenException('Only the seller can do this');
    const res = await this.prisma.sellerInvoice.updateMany({
      where: { id: invoiceId, status: 'PAYMENT_SUBMITTED' },
      data: { status: 'ISSUED', paymentRejectedNote: reason.trim(), paymentSubmittedAt: null, paymentSubmittedById: null },
    });
    if (res.count === 0) throw new BadRequestException('There is no submitted payment to send back on this invoice.');
    await this.notifications.notify({
      userId: inv.buyerId,
      type: NotificationType.PAYMENT_DUE,
      title: `Payment not received for ${inv.invoiceNumber}`,
      body: `The seller could not match your payment: ${reason.trim()}. Please check and submit again.`,
      data: destination('/buyer', { tab: 'orders', entityType: 'invoice', entityId: invoiceId }),
    });
    await recordAudit(this.prisma, sellerId, 'seller_invoice_payment_rejected', 'invoice', invoiceId, { reason });
    return this.get(invoiceId, sellerId, 'SELLER');
  }

  async void(invoiceId: string, actorId: string, actorRole: string, reason: string) {
    const inv = await this.prisma.sellerInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const isAdmin = actorRole === 'ADMIN';
    if (inv.sellerId !== actorId && !isAdmin) throw new ForbiddenException('Only the seller can void this invoice');
    const res = await this.prisma.sellerInvoice.updateMany({
      where: { id: invoiceId, status: { in: VOIDABLE as any } },
      data: { status: 'VOID', voidedAt: new Date(), voidedById: actorId, voidReason: reason.trim() },
    });
    if (res.count === 0) throw new BadRequestException(inv.status === 'VOID' ? 'This invoice is already void.' : 'A confirmed invoice cannot be voided.');
    await this.notifications.notify({
      userId: inv.buyerId,
      type: NotificationType.PAYMENT_DUE,
      title: `Invoice ${inv.invoiceNumber} was voided`,
      body: `Reason: ${reason.trim()}. A corrected invoice may follow.`,
      data: destination('/buyer', { tab: 'orders', entityType: 'invoice', entityId: invoiceId }),
    });
    await recordAudit(this.prisma, actorId, 'seller_invoice_voided', 'invoice', invoiceId, { reason });
    return this.get(invoiceId, actorId, isAdmin ? 'ADMIN' : 'SELLER');
  }

  // ─── PDF ──────────────────────────────────────────────────────────────────
  // Buyer-facing document: full amount owed + terms. No platform fee / seller net.
  private async ensurePdf(invoiceId: string): Promise<string> {
    const inv = await this.prisma.sellerInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        order: { include: { statusHistory: true } },
        seller: { select: { profile: { select: { fullName: true, businessName: true, address: true, city: true } } } },
        buyer: { select: { profile: { select: { fullName: true, businessName: true, address: true, city: true } } } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.s3Key) return inv.s3Key;

    const schedule = this.liveSchedule(inv, inv.order);
    const sp = inv.seller?.profile as any; const bp = inv.buyer?.profile as any;
    const lineItems: PdfLineItem[] = [{ label: inv.itemDescription, amount: Number(inv.orderAmount) }];
    schedule.forEach((s) => lineItems.push({
      label: `   ${s.label}: ₨${s.amount.toLocaleString('en-PK', { minimumFractionDigits: 2 })} - ${s.dueRule}${s.dueDate ? ` (${s.dueDate.toLocaleDateString('en-GB')})` : ''}`,
    }));
    const pdf = await renderPdfDocument({
      documentTitle: 'INVOICE',
      documentNumber: inv.invoiceNumber,
      issuedAt: inv.issuedAt,
      fromLines: [sp?.businessName || sp?.fullName || 'Seller', sp?.address || '', sp?.city || ''].filter(Boolean),
      toLines: [bp?.businessName || bp?.fullName || 'Buyer', bp?.address || '', bp?.city || ''].filter(Boolean),
      meta: [
        ['Order', inv.orderId.slice(0, 8).toUpperCase()],
        ['Payment terms', describeTerms(inv.paymentTermsSnapshot as any)],
        ...(inv.version > 1 ? [['Version', `${inv.version} (replaces an earlier invoice)`] as [string, string]] : []),
      ],
      lineItems,
      totalLabel: 'TOTAL AMOUNT DUE',
      totalAmount: Number(inv.orderAmount),
      footerNote: 'Pay the seller directly and submit your payment reference on AgriConnect. The seller confirms receipt. This is not a receipt of payment.',
    });
    const key = `seller-invoices/${inv.id}.pdf`;
    await this.storage.putObject(key, pdf, 'application/pdf');
    await this.prisma.sellerInvoice.update({ where: { id: inv.id }, data: { s3Key: key } });
    return key;
  }

  private liveSchedule(inv: any, order: any): ScheduleItem[] {
    return computeSchedule(inv.paymentTermsSnapshot as PaymentTerms | null, Number(inv.orderAmount), contextFromOrder(order, inv.issuedAt));
  }

  // ─── READS ────────────────────────────────────────────────────────────────
  private shape(inv: any, role: 'BUYER' | 'SELLER' | 'ADMIN') {
    const { s3Key, order, seller, buyer, ...rest } = inv;
    const schedule = order ? this.liveSchedule(inv, order) : (inv.schedule as any[]);
    const out: any = {
      ...rest,
      termsSummary: describeTerms(inv.paymentTermsSnapshot),
      schedule,
      dueDate: schedule.every((s: any) => s.dueDate) ? finalDueDate(schedule as ScheduleItem[]) : null,
      sellerName: seller?.profile?.businessName || seller?.profile?.fullName,
      buyerName: buyer?.profile?.businessName || buyer?.profile?.fullName,
      orderStatus: order?.status,
    };
    if (role === 'BUYER') {
      delete out.platformFeePct; delete out.platformFee; delete out.sellerNet; delete out.paymentConfirmedById; delete out.voidedById;
    } else {
      out.sellerSettlement = { platformFeePct: Number(inv.platformFeePct), platformFee: Number(inv.platformFee), sellerNet: Number(inv.sellerNet) };
    }
    return out;
  }

  private includeForView() {
    return {
      order: { include: { statusHistory: true } },
      seller: { select: { profile: { select: { fullName: true, businessName: true } } } },
      buyer: { select: { profile: { select: { fullName: true, businessName: true } } } },
    };
  }

  async get(invoiceId: string, userId: string, role: string) {
    const inv: any = await this.prisma.sellerInvoice.findUnique({ where: { id: invoiceId }, include: this.includeForView() });
    if (!inv) throw new NotFoundException('Invoice not found');
    const isAdmin = role === 'ADMIN' || role === 'MODERATOR';
    const party = inv.sellerId === userId ? 'SELLER' : inv.buyerId === userId ? 'BUYER' : isAdmin ? 'ADMIN' : null;
    if (!party) throw new ForbiddenException('Access denied');
    let downloadUrl: string | null = null;
    if (inv.status !== 'VOID') {
      try {
        const key = inv.s3Key || (await this.ensurePdf(inv.id));
        downloadUrl = await this.storage.getPresignedUrl(key, 600);
      } catch { downloadUrl = null; }
    }
    return { ...this.shape(inv, party), downloadUrl };
  }

  async listMine(userId: string, as: 'buyer' | 'seller') {
    const rows = await this.prisma.sellerInvoice.findMany({
      where: as === 'seller' ? { sellerId: userId } : { buyerId: userId },
      include: this.includeForView(),
      orderBy: { issuedAt: 'desc' },
    });
    return rows.map((r: any) => this.shape(r, as === 'seller' ? 'SELLER' : 'BUYER'));
  }

  async forOrder(orderId: string, userId: string, role: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { sellerId: true, buyerId: true } });
    if (!order) throw new NotFoundException('Order not found');
    const isAdmin = role === 'ADMIN' || role === 'MODERATOR';
    if (order.sellerId !== userId && order.buyerId !== userId && !isAdmin) throw new ForbiddenException('Access denied');
    const rows = await this.prisma.sellerInvoice.findMany({ where: { orderId }, include: this.includeForView(), orderBy: { issuedAt: 'desc' } });
    const party = order.sellerId === userId ? 'SELLER' : order.buyerId === userId ? 'BUYER' : 'ADMIN';
    return rows.map((r: any) => this.shape(r, party));
  }
}
