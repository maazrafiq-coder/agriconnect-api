// ─── OFFERS SERVICE ───────────────────────────────────────────────────────────
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OfferStatus, OrderStatus, PaymentStatus, TransactionType } from '@prisma/client';
import {
  IsString, IsNumber, IsOptional, IsDateString, Min,
} from 'class-validator';

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export class CreateOfferDto {
  @IsString()
  productId: string;

  @IsNumber() @Min(0)
  offeredPrice: number;

  @IsNumber() @Min(0)
  quantity: number;

  @IsOptional() @IsString()
  message?: string;
}

export class CounterOfferDto {
  @IsNumber() @Min(0)
  counterPrice: number;

  @IsOptional() @IsString()
  counterMessage?: string;
}

@Injectable()
export class OffersService {
  constructor(private prisma: PrismaService) {}

  async create(buyerId: string, dto: CreateOfferDto) {
    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId === buyerId) throw new BadRequestException('Cannot make offer on your own product');
    if (dto.quantity < product.minOrderQty) throw new BadRequestException(`Minimum order is ${product.minOrderQty} ${product.unit}`);

    return this.prisma.offer.create({
      data: {
        productId: dto.productId,
        buyerId,
        offeredPrice: dto.offeredPrice,
        quantity: dto.quantity,
        message: dto.message,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), // 72h expiry
      },
      include: {
        product: { select: { name: true, unit: true, sellerId: true } },
        buyer: { select: { profile: { select: { fullName: true } } } },
      },
    });
  }

  async accept(offerId: string, sellerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (offer.status !== OfferStatus.PENDING && offer.status !== OfferStatus.COUNTERED) {
      throw new BadRequestException(`Cannot accept offer in ${offer.status} status`);
    }

    const totalAmount = Number(offer.offeredPrice) * offer.quantity;
    const platformFeePct = 1.5;
    const platformFee = totalAmount * platformFeePct / 100;

    // Idempotency guard: use updateMany with a status precondition so a
    // double-submit (double-tap, retried request, race between two tabs)
    // can only ever succeed once. The second call sees count === 0 and
    // fails cleanly instead of creating a duplicate order.
    const guarded = await this.prisma.offer.updateMany({
      where: { id: offerId, status: { in: [OfferStatus.PENDING, OfferStatus.COUNTERED] } },
      data: { status: OfferStatus.ACCEPTED },
    });
    if (guarded.count === 0) {
      throw new BadRequestException('This offer was already processed');
    }

    // Create order
    const [updatedOffer, order] = await this.prisma.$transaction([
      this.prisma.offer.findUnique({ where: { id: offerId } }),
      this.prisma.order.create({
        data: {
          offerId,
          sellerId,
          buyerId: offer.buyerId,
          totalAmount,
          platformFeePct,
          platformFee,
          netSellerAmount: totalAmount - platformFee,
          status: OrderStatus.CONFIRMED,
          statusHistory: {
            create: { status: OrderStatus.CONFIRMED, changedBy: sellerId, note: 'Offer accepted' },
          },
        },
        include: {
          offer: { include: { product: { select: { name: true, unit: true } } } },
          seller: { select: { profile: { select: { fullName: true } } } },
          buyer: { select: { profile: { select: { fullName: true } } } },
        },
      }),
    ]);

    // Ledger entries — the Transaction model previously had a schema but
    // no writers. Record the platform fee and the seller's expected net
    // amount so financial reporting (revenue, seller payouts) has a
    // source of truth instead of being recomputed ad-hoc from orders.
    await this.prisma.transaction.createMany({
      data: [
        {
          userId: sellerId,
          type: TransactionType.ORDER_PAYMENT,
          amount: totalAmount - platformFee,
          description: `Net proceeds from order ${order.id}`,
          referenceId: order.id,
          referenceType: 'order',
        },
        {
          userId: sellerId,
          type: TransactionType.PLATFORM_FEE,
          amount: platformFee,
          description: `Platform fee (${platformFeePct}%) on order ${order.id}`,
          referenceId: order.id,
          referenceType: 'order',
        },
      ],
    });

    return { offer: updatedOffer, order };
  }

  async reject(offerId: string, sellerId: string, reason?: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    return this.prisma.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.REJECTED, rejectionReason: reason || undefined },
    });
  }

  async counter(offerId: string, sellerId: string, dto: CounterOfferDto) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (offer.status !== OfferStatus.PENDING) throw new BadRequestException('Can only counter pending offers');

    return this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status: OfferStatus.COUNTERED,
        counterPrice: dto.counterPrice,
        counterMessage: dto.counterMessage,
      },
    });
  }

  async getSellerOffers(sellerId: string) {
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
  constructor(private prisma: PrismaService) {}

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

  async updateStatus(orderId: string, userId: string, status: OrderStatus, note?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
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

    const extraData: Record<string, any> = {};
    if (status === OrderStatus.COMPLETED) extraData.completedAt = new Date();
    if (status === OrderStatus.CANCELLED) {
      extraData.cancelledAt = new Date();
      extraData.cancelReason = note;
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.order.update({ where: { id: orderId }, data: { status, ...extraData } }),
      this.prisma.orderStatusHistory.create({
        data: { orderId, status, changedBy: userId, note },
      }),
    ]);
    return updated;
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
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.DISPUTED) {
      throw new BadRequestException('Only disputed orders can be resolved through this endpoint');
    }

    const newStatus = resolution === 'completed' ? OrderStatus.COMPLETED : OrderStatus.CANCELLED;

    const [updated] = await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          ...(resolution === 'completed' ? { completedAt: new Date() } : { cancelledAt: new Date(), cancelReason: note }),
        },
      }),
      this.prisma.orderStatusHistory.create({
        data: { orderId, status: newStatus, changedBy: adminId, note: `Dispute resolved by admin: ${note}` },
      }),
    ]);

    return updated;
  }
}
