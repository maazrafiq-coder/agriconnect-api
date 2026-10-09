// ─── OFFERS SERVICE ───────────────────────────────────────────────────────────
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationType, OfferStatus, OrderStatus, PaymentStatus, ProductStatus, TransactionType } from '@prisma/client';
import { recordAudit } from '../common/utils/audit.util';
import { NotificationsService } from '../notifications/notifications.service';
import {
  IsString, IsNumber, IsOptional, IsDateString, IsPositive,
} from 'class-validator';

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export class CreateOfferDto {
  @IsString()
  productId: string;

  @IsNumber() @IsPositive()
  offeredPrice: number;

  @IsNumber() @IsPositive()
  quantity: number;

  @IsOptional() @IsString()
  message?: string;
}

export class CounterOfferDto {
  @IsNumber() @IsPositive()
  counterPrice: number;

  @IsOptional() @IsString()
  counterMessage?: string;
}

@Injectable()
export class OffersService {
  constructor(private prisma: PrismaService, private settings: SettingsService, private notifications: NotificationsService) {}

  // Accounts that aren't fully APPROVED yet (e.g. INFO_REQUESTED — see
  // auth.service.login()'s comment on why those users can now log in at
  // all) can browse and respond to admin requests, but must not be able
  // to transact. Checked against a fresh read rather than the JWT's
  // (possibly stale) kycStatus claim, since a previously-approved account
  // can be moved back to INFO_REQUESTED after the token was issued.
  private async assertCanTransact(
    userId: string,
    action: 'make an offer on' | 'accept offers on' | 'accept counter-offers on',
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } });
    if (!user || user.kycStatus !== 'APPROVED') {
      throw new ForbiddenException(`Your account must be fully approved before you can ${action} listings.`);
    }
  }

  private static readonly OFFER_TTL_MS = 72 * 60 * 60 * 1000;
  private static readonly OPEN_OFFER_STATES: OfferStatus[] = [
  OfferStatus.PENDING,
  OfferStatus.COUNTERED,
];

  // Offer expiry is enforced lazily: whenever an offer is acted on we first
  // check its deadline, and list queries sweep stale rows. (No cron needed.)
  private async failIfExpired(offer: { id: string; status: OfferStatus; expiresAt?: Date | null }) {
    if (
      offer.expiresAt &&
      offer.expiresAt.getTime() < Date.now() &&
      OffersService.OPEN_OFFER_STATES.includes(offer.status)
    ) {
      await this.prisma.offer.updateMany({
        where: { id: offer.id, status: { in: OffersService.OPEN_OFFER_STATES } },
        data: { status: OfferStatus.EXPIRED },
      });
      throw new BadRequestException('This offer has expired');
    }
  }

  private async sweepExpired(where: Record<string, any>) {
    await this.prisma.offer.updateMany({
      where: { ...where, status: { in: OffersService.OPEN_OFFER_STATES }, expiresAt: { lt: new Date() } },
      data: { status: OfferStatus.EXPIRED },
    });
  }

  async create(buyerId: string, dto: CreateOfferDto) {
    await this.assertCanTransact(buyerId, 'make an offer on');

    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.status !== ProductStatus.ACTIVE) throw new BadRequestException('This listing is not available for offers');
    if (product.sellerId === buyerId) throw new BadRequestException('Cannot make offer on your own product');
    if (dto.quantity < product.minOrderQty) throw new BadRequestException(`Minimum order is ${product.minOrderQty} ${product.unit}`);
    if (dto.quantity > product.quantity) throw new BadRequestException(`Only ${product.quantity} ${product.unit} available`);

    const created = await this.prisma.offer.create({
      data: {
        productId: dto.productId,
        buyerId,
        offeredPrice: dto.offeredPrice,
        quantity: dto.quantity,
        message: dto.message,
        expiresAt: new Date(Date.now() + OffersService.OFFER_TTL_MS), // 72h expiry
      },
      include: {
        product: { select: { name: true, unit: true, sellerId: true } },
        buyer: { select: { profile: { select: { fullName: true } } } },
      },
    });
    await this.notifications.notify({
      userId: product.sellerId,
      type: NotificationType.OFFER_RECEIVED,
      title: 'New offer on your listing',
      body: `${created.buyer?.profile?.fullName || 'A buyer'} offered ₨${Number(dto.offeredPrice).toLocaleString()} × ${dto.quantity} ${product.unit} for ${product.name}.`,
      data: { link: '/seller', offerId: created.id },
    });
    return created;
  }

  // Seller accepts the buyer's ORIGINAL offer. A countered offer can only be
  // closed by the buyer (see acceptCounter) — previously the seller could
  // "accept" a countered offer and the order silently used the buyer's
  // original price instead of the counter.
  async accept(offerId: string, sellerId: string) {
    await this.assertCanTransact(sellerId, 'accept offers on');

    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (offer.status === OfferStatus.COUNTERED) {
      throw new BadRequestException('You countered this offer — waiting for the buyer to accept or decline your counter.');
    }
    if (offer.status !== OfferStatus.PENDING) {
      throw new BadRequestException(`Cannot accept offer in ${offer.status} status`);
    }
    await this.failIfExpired(offer);

    return this.createOrderFromOffer(offer, Number(offer.offeredPrice), sellerId, 'Offer accepted');
  }

  // Buyer accepts the seller's counter-offer. The order is created at the
  // COUNTER price.
  async acceptCounter(offerId: string, buyerId: string) {
    await this.assertCanTransact(buyerId, 'accept counter-offers on');

    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.buyerId !== buyerId) throw new ForbiddenException('Not your offer');
    if (offer.status !== OfferStatus.COUNTERED || offer.counterPrice == null) {
      throw new BadRequestException('There is no counter-offer to accept on this offer');
    }
    await this.failIfExpired(offer);

    return this.createOrderFromOffer(offer, Number(offer.counterPrice), buyerId, 'Counter-offer accepted by buyer');
  }

  // Everything an acceptance changes happens in ONE transaction, so a
  // failure part-way can no longer leave an ACCEPTED offer with no order or
  // an order without its stock deducted:
  //   1. offer -> ACCEPTED (guarded on the status we read, so a double-tap
  //      or two-tab race can only succeed once)
  //   2. product stock -= quantity (guarded: must be live and have enough)
  //      and the listing flips to SOLD when it hits zero
  //   3. competing open offers that can no longer be fulfilled are closed
  //   4. order + status history + ledger rows are created
  private async createOrderFromOffer(
    offer: { id: string; productId: string; buyerId: string; quantity: number; status: OfferStatus; product: { sellerId: string } },
    unitPrice: number,
    actorId: string,
    note: string,
  ) {
    const sellerId = offer.product.sellerId;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const totalAmount = round2(unitPrice * offer.quantity);
    // Admin-configurable (Settings → platform fee); the % in force at
    // acceptance is frozen onto the order.
    const platformFeePct = await this.settings.getPlatformFeePct();
    const platformFee = round2((totalAmount * platformFeePct) / 100);

    const result = await this.prisma.$transaction(async (tx) => {
      const guarded = await tx.offer.updateMany({
        where: { id: offer.id, status: offer.status },
        data: { status: OfferStatus.ACCEPTED },
      });
      if (guarded.count === 0) throw new BadRequestException('This offer was already processed');

      const stock = await tx.product.updateMany({
        where: {
          id: offer.productId,
          status: { in: [ProductStatus.ACTIVE, ProductStatus.UNDER_OFFER] },
          quantity: { gte: offer.quantity },
        },
        data: { quantity: { decrement: offer.quantity } },
      });
      if (stock.count === 0) {
        throw new BadRequestException('This listing is no longer available in the offered quantity');
      }

      const product = await tx.product.findUnique({ where: { id: offer.productId }, select: { quantity: true } });
      const remaining = product?.quantity ?? 0;
      if (remaining <= 0) {
        await tx.product.update({ where: { id: offer.productId }, data: { status: ProductStatus.SOLD } });
      }

      await tx.offer.updateMany({
        where: {
          productId: offer.productId,
          id: { not: offer.id },
          status: { in: OffersService.OPEN_OFFER_STATES },
          quantity: { gt: Math.max(remaining, 0) },
        },
        data: {
          status: OfferStatus.REJECTED,
          rejectionReason: remaining <= 0 ? 'This listing has been sold.' : 'Not enough stock left after another order was confirmed.',
        },
      });

      const order = await tx.order.create({
        data: {
          offerId: offer.id,
          sellerId,
          buyerId: offer.buyerId,
          totalAmount,
          platformFeePct,
          platformFee,
          netSellerAmount: round2(totalAmount - platformFee),
          status: OrderStatus.CONFIRMED,
          statusHistory: {
            create: { status: OrderStatus.CONFIRMED, changedBy: actorId, note },
          },
        },
        include: {
          offer: { include: { product: { select: { name: true, unit: true } } } },
          seller: { select: { profile: { select: { fullName: true } } } },
          buyer: { select: { profile: { select: { fullName: true } } } },
        },
      });

      // No ledger rows here on purpose: nothing has been paid or earned yet.
      // The sale is booked when the order is COMPLETED (see
      // OrdersService.recordSettlement).

      const updatedOffer = await tx.offer.findUnique({ where: { id: offer.id } });
      return { offer: updatedOffer, order };
    });

    // Tell the party who did NOT click accept.
    const otherParty = actorId === sellerId ? offer.buyerId : sellerId;
    await this.notifications.notify({
      userId: otherParty,
      type: NotificationType.OFFER_ACCEPTED,
      title: actorId === sellerId ? 'Your offer was accepted' : 'Your counter-offer was accepted',
      body: `An order of ₨${totalAmount.toLocaleString()} was created at ₨${unitPrice.toLocaleString()} per unit.`,
      data: { link: actorId === sellerId ? '/buyer' : '/seller', orderId: (result as any).order?.id },
    });
    return result;
  }

  async reject(offerId: string, sellerId: string, reason?: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (!OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
      throw new BadRequestException(`Cannot reject an offer in ${offer.status} status`);
    }

    const res = await this.prisma.offer.updateMany({
      where: { id: offerId, status: { in: OffersService.OPEN_OFFER_STATES } },
      data: { status: OfferStatus.REJECTED, rejectionReason: reason || undefined },
    });
    if (res.count === 0) throw new BadRequestException('This offer was already processed');
    await this.notifications.notify({
      userId: offer.buyerId,
      type: NotificationType.OFFER_REJECTED,
      title: 'Your offer was declined',
      body: `The seller declined your offer on ${offer.product.name}${reason ? `: ${reason}` : '.'}`,
      data: { link: '/buyer', offerId },
    });
    return this.prisma.offer.findUnique({ where: { id: offerId } });
  }

  // Buyer withdraws an open offer, or declines the seller's counter.
  async withdraw(offerId: string, buyerId: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId }, include: { product: { select: { sellerId: true, name: true } } } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.buyerId !== buyerId) throw new ForbiddenException('Not your offer');
    if (!OffersService.OPEN_OFFER_STATES.includes(offer.status)) {
      throw new BadRequestException(`Cannot withdraw an offer in ${offer.status} status`);
    }

    const res = await this.prisma.offer.updateMany({
      where: { id: offerId, status: { in: OffersService.OPEN_OFFER_STATES } },
      data: { status: OfferStatus.WITHDRAWN },
    });
    if (res.count === 0) throw new BadRequestException('This offer was already processed');
    if (offer.product?.sellerId) {
      await this.notifications.notify({
        userId: offer.product.sellerId,
        type: NotificationType.OFFER_REJECTED,
        title: offer.status === OfferStatus.COUNTERED ? 'Your counter-offer was declined' : 'An offer was withdrawn',
        body: `The buyer ${offer.status === OfferStatus.COUNTERED ? 'declined your counter on' : 'withdrew their offer on'} ${offer.product.name}.`,
        data: { link: '/seller', offerId },
      });
    }
    return this.prisma.offer.findUnique({ where: { id: offerId } });
  }

  async counter(offerId: string, sellerId: string, dto: CounterOfferDto) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (offer.status !== OfferStatus.PENDING) throw new BadRequestException('Can only counter pending offers');
    await this.failIfExpired(offer);

    const countered = await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: OfferStatus.COUNTERED,
        counterPrice: dto.counterPrice,
        counterMessage: dto.counterMessage,
        // Give the buyer a fresh window to answer the counter.
        expiresAt: new Date(Date.now() + OffersService.OFFER_TTL_MS),
      },
    });
    await this.notifications.notify({
      userId: offer.buyerId,
      type: NotificationType.OFFER_RECEIVED,
      title: 'The seller sent a counter-offer',
      body: `Counter of ₨${Number(dto.counterPrice).toLocaleString()} on ${offer.product.name}. Accept or decline within 72 hours.`,
      data: { link: '/buyer', offerId },
    });
    return countered;
  }

  async getSellerOffers(sellerId: string) {
    await this.sweepExpired({ product: { sellerId } });
    return this.prisma.offer.findMany({
      where: { product: { sellerId } },
      include: {
        product: { select: { id: true, name: true, unit: true, askingPrice: true } },
        buyer: { select: { id: true, profile: { select: { fullName: true, city: true } }, kycStatus: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBuyerOffers(buyerId: string) {
    await this.sweepExpired({ buyerId });
    return this.prisma.offer.findMany({
      where: { buyerId },
      include: {
        product: {
          select: { id: true, name: true, unit: true, askingPrice: true, seller: { select: { profile: { select: { fullName: true } } } } },
        },
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
        offer: { include: { product: { include: { riceDetails: true, media: { take: 1 } } } } },
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
    return order;
  }

  // Cancelling an order puts its quantity back on the listing (and
  // re-opens it if that sale had marked it SOLD).
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
      if (status === OrderStatus.CANCELLED && order.offer) await this.restoreStock(tx, order.offer);
      if (status === OrderStatus.COMPLETED) await this.recordSettlement(tx, order);
      return tx.order.findUnique({ where: { id: orderId } });
    });

    const other = userId === order.sellerId ? order.buyerId : order.sellerId;
    await this.notifications.notify({
      userId: other,
      type: NotificationType.ORDER_UPDATE,
      title: `Order ${status.toLowerCase().replace('_', ' ')}`,
      body: `Order ${orderId.slice(0, 8)} is now ${status.replace('_', ' ').toLowerCase()}${note ? ` — ${note}` : ''}.`,
      data: { link: other === order.buyerId ? '/buyer' : '/seller', orderId },
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
      if (newStatus === OrderStatus.CANCELLED && order.offer) await this.restoreStock(tx, order.offer);
      if (newStatus === OrderStatus.COMPLETED) await this.recordSettlement(tx, order);
      return updated;
    });
    await recordAudit(this.prisma, adminId, 'dispute_resolved', 'order', orderId, { resolution, note });
    await this.notifications.notifyMany([order.buyerId, order.sellerId].map((uid) => ({
      userId: uid,
      type: NotificationType.ORDER_UPDATE,
      title: 'Dispute resolved',
      body: `An admin resolved the dispute on order ${orderId.slice(0, 8)} as ${resolution}. ${note}`,
      data: { link: uid === order.buyerId ? '/buyer' : '/seller', orderId },
    })));
    return resolved;
  }
}
