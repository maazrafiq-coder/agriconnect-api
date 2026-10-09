import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { recordAudit } from '../common/utils/audit.util';
import { SettingsService } from '../settings/settings.service';
import { ReceiptStatus, LienStatus, TransactionType, BookingStatus, NotificationType } from '@prisma/client';
import {
  IsString, IsNumber, IsOptional, IsBoolean, IsDateString, IsArray, IsObject, IsIn, Min, MinLength, MaxLength,
} from 'class-validator';
import { v4 as uuidv4 } from 'uuid';
import { withBookingReference, withBookingReferences, formatBookingReference } from '../common/utils/booking-reference.util';
import { formatDocumentNumber } from '../common/utils/document-number.util';
import { renderPdfDocument, PdfLineItem } from '../common/pdf/pdf.util';

// Booking statuses that reserve warehouse capacity — a REQUESTED booking
// isn't confirmed yet, but the tonnage is held so two buyers can't be
// promised the same space while the operator is deciding. Released back
// to the pool on REJECTED/CANCELLED; consumed for real once COMPLETED
// (goods have left, so it drops out of every "in use" query below).
const CAPACITY_HELD_STATUSES: BookingStatus[] = [
  BookingStatus.REQUESTED,
  BookingStatus.ACCEPTED,
  BookingStatus.ACTIVE,
];

// A lien blocks release of the goods from the moment it is applied for
// (PENDING) until the bank's clearance is recorded — otherwise the goods
// could leave the warehouse while the application is still being decided.
const LIEN_BLOCKING_STATUSES: LienStatus[] = [LienStatus.PENDING, LienStatus.ACTIVE];

const INVOICEABLE_STATUSES: BookingStatus[] = [BookingStatus.ACCEPTED, BookingStatus.ACTIVE, BookingStatus.COMPLETED];

// Round 2 Milestone 2: explicit allow-list of legal transitions. Anything
// not listed here is rejected with a clear error instead of silently
// overwriting status — this is what makes the lifecycle a real state
// machine instead of an arbitrary string anyone could set to anything.
const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  [BookingStatus.REQUESTED]: [BookingStatus.ACCEPTED, BookingStatus.REJECTED, BookingStatus.CANCELLED],
  [BookingStatus.ACCEPTED]: [BookingStatus.ACTIVE, BookingStatus.CANCELLED],
  [BookingStatus.REJECTED]: [],
  [BookingStatus.ACTIVE]: [BookingStatus.COMPLETED],
  [BookingStatus.COMPLETED]: [],
  [BookingStatus.CANCELLED]: [],
};

function assertTransition(from: BookingStatus, to: BookingStatus) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new BadRequestException(`Booking cannot move from ${from} to ${to}`);
  }
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────
export class CreateWarehouseDto {
  @IsString() name: string;
  @IsString() type: string;
  @IsString() city: string;
  @IsString() province: string;
  @IsString() address: string;
  @IsOptional() @IsString() gpsCoordinates?: string;
  @IsNumber() @Min(1) totalCapacityTons: number;
  @IsNumber() @Min(0) pricePerTonMonth: number;
  // Optional per-commodity rate overrides — see schema comment on
  // WarehouseProfile.ratesByCommodity for the shape and fallback rule.
  @IsOptional() @IsObject() ratesByCommodity?: Record<string, number>;
  @IsOptional() @IsNumber() @Min(0) insurancePricePerTonMonth?: number;
  @IsNumber() @Min(1) minDurationDays: number;
  @IsArray() @IsString({ each: true }) commoditiesAccepted: string[];
  @IsOptional() @IsArray() certifications?: string[];
  @IsOptional() @IsArray() features?: string[];
  @IsOptional() @IsArray() bankPartners?: string[];
  @IsOptional() @IsBoolean() insuranceAvailable?: boolean;
  @IsOptional() @IsString() description?: string;
}

// Operator editing their own warehouse (NEW_Changes item 10 — there was
// previously no way to change anything after registration). Everything
// optional; only fields the operator actually sends get updated. Deliberately
// excludes isVerified/isActive (admin-only — see adminVerify/adminSetActive)
// and userId/id (identity, never editable).
export class UpdateWarehouseDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() gpsCoordinates?: string;
  @IsOptional() @IsNumber() @Min(1) totalCapacityTons?: number;
  @IsOptional() @IsNumber() @Min(0) pricePerTonMonth?: number;
  @IsOptional() @IsObject() ratesByCommodity?: Record<string, number>;
  @IsOptional() @IsNumber() @Min(0) insurancePricePerTonMonth?: number;
  @IsOptional() @IsNumber() @Min(1) minDurationDays?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) commoditiesAccepted?: string[];
  @IsOptional() @IsArray() certifications?: string[];
  @IsOptional() @IsArray() features?: string[];
  @IsOptional() @IsArray() bankPartners?: string[];
  @IsOptional() @IsBoolean() insuranceAvailable?: boolean;
  @IsOptional() @IsString() managerName?: string;
  @IsOptional() @IsString() managerPhone?: string;
  @IsOptional() @IsString() description?: string;
}

export class BookStorageDto {
  @IsString() warehouseId: string;
  @IsString() commodity: string;
  @IsOptional() @IsString() variety?: string;
  @IsNumber() @Min(0.1) quantityTons: number;
  @IsOptional() @IsString() packagingType?: string;
  @IsDateString() entryDate: string;
  @IsNumber() @Min(1) durationDays: number;
  @IsOptional() @IsBoolean() includeInsurance?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class WarehouseQueryDto {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() commodity?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsNumber() @Min(0) minCapacity?: number;
  @IsOptional() @IsNumber() @Min(1) page?: number = 1;
  @IsOptional() @IsNumber() @Min(1) limit?: number = 20;
}

export class ApplyLienDto {
  @IsString() receiptId: string;
  @IsString() bankName: string;
  @IsString() loanPurpose: string;
  @IsNumber() @Min(1) loanAmount: number;
  @IsNumber() @Min(0) interestRate: number;
  @IsNumber() @Min(1) tenureMonths: number;
  @IsOptional() @IsString() loanOfficer?: string;
}

export class ConfirmLienDto {
  @IsString() @MinLength(3) loanRefNo: string;           // bank's loan / sanction reference
  @IsOptional() @IsNumber() @Min(0) interestRate?: number; // final rate, if different from the indicative one applied for
  @IsOptional() @IsString() note?: string;
}

// Only receiptId matters: provider, premium and cover are worked out on the
// server from the warehouse's own insurance rate and the receipt's value.
// The other fields are accepted (and ignored) so older clients don't break.
export class BuyInsuranceDto {
  @IsString() receiptId: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() planName?: string;
  @IsOptional() @IsNumber() @Min(0) coverageAmount?: number;
  @IsOptional() @IsNumber() @Min(0) premiumAmount?: number;
  @IsOptional() @IsString() coverage?: string;
}

export class PostBookingMessageDto {
  @IsString() @MinLength(1) @MaxLength(2000) body: string;
  // INFO_REQUEST is only honoured when the sender is the warehouse operator.
  @IsOptional() @IsIn(['MESSAGE', 'INFO_REQUEST']) kind?: 'MESSAGE' | 'INFO_REQUEST';
}

export class RejectBookingDto {
  @IsString() reason: string;
}

export class CancelBookingDto {
  @IsOptional() @IsString() reason?: string;
}

// ─── SERVICE ─────────────────────────────────────────────────────────────────
@Injectable()
export class WarehouseService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  // A booking invoice's money is booked in the ledger only when payment is
  // actually confirmed (see confirmInvoicePayment) and reversed with a
  // REFUND row if that booking is then cancelled / rejected.
  private async refundIfPaid(tx: any, booking: { id: string; depositorId: string }, reason: string) {
    const invoice = await tx.warehouseInvoice.findUnique({ where: { bookingId: booking.id } });
    if (!invoice || invoice.status !== 'PAID') return;
    await tx.transaction.create({
      data: {
        userId: booking.depositorId,
        type: TransactionType.REFUND,
        amount: invoice.totalAmount,
        description: `Refund due: storage booking ${reason} after invoice ${invoice.invoiceNumber} was paid`,
        referenceId: booking.id,
        referenceType: 'storage',
      },
    });
  }

  // ─── LIEN GUARD ───────────────────────────────────────────────────────────
  // Goods under an ACTIVE bank lien are the bank's collateral: the warehouse
  // must not release them (no gate-out pass) until the bank's clearance has
  // been recorded via releaseLien(). Returns the lien or null.
  private async getActiveLien(bookingId: string) {
    const receipt = await this.prisma.warehouseReceipt.findUnique({
      where: { bookingId },
      include: { lien: true },
    });
    return receipt?.lien && LIEN_BLOCKING_STATUSES.includes(receipt.lien.status) ? receipt.lien : null;
  }

  private lienBlockMessage(lien: { bankName: string; loanAmount: any; status?: LienStatus }, action: string) {
    if (lien.status === LienStatus.PENDING) {
      return `A ₨${Number(lien.loanAmount).toLocaleString()} loan application with ${lien.bankName} is pending confirmation on these goods. ${action} until it is confirmed and cleared, or declined / withdrawn.`;
    }
    return `These goods are under an active bank lien (${lien.bankName}, ₨${Number(lien.loanAmount).toLocaleString()}). ${action} until the bank's clearance has been recorded.`;
  }

  // ─── BROWSE WAREHOUSES ────────────────────────────────────────────────────
  async findAll(query: WarehouseQueryDto) {
    const where: any = { isActive: true };

    if (query.type) where.type = query.type;
    if (query.province) where.province = { contains: query.province, mode: 'insensitive' };
    if (query.commodity) where.commoditiesAccepted = { has: query.commodity };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { city: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.minCapacity) where.totalCapacityTons = { gte: query.minCapacity };

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100); // hard cap prevents ?limit=999999 abuse

    const [warehouses, total] = await Promise.all([
      this.prisma.warehouseProfile.findMany({
        where,
        include: { _count: { select: { bookings: true, receipts: true } } },
        orderBy: [{ isVerified: 'desc' }, { rating: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.warehouseProfile.count({ where }),
    ]);

    // Single groupBy query for ALL warehouses' used capacity, instead of
    // one aggregate() round-trip per warehouse (was N+1 — 500 warehouses
    // meant 500 sequential queries on every browse-page load).
    const usage = await this.prisma.storageBooking.groupBy({
      by: ['warehouseId'],
      where: {
        warehouseId: { in: warehouses.map((w) => w.id) },
        status: { in: CAPACITY_HELD_STATUSES },
      },
      _sum: { quantityTons: true },
    });
    const usedByWarehouse = new Map<string, number>(
      usage.map((u) => [u.warehouseId as string, (u._sum.quantityTons as number) || 0]),
    );

    return {
      data: warehouses.map((w) => ({
        ...w,
        availableCapacityTons: w.totalCapacityTons - (usedByWarehouse.get(w.id) || 0),
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── WAREHOUSE DETAIL ─────────────────────────────────────────────────────
  async findOne(id: string) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({
      where: { id },
      include: {
        user: { select: { profile: { select: { fullName: true, city: true } } } },
        _count: { select: { bookings: true, receipts: true } },
      },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const activeBookings = await this.prisma.storageBooking.aggregate({
      where: { warehouseId: id, status: { in: CAPACITY_HELD_STATUSES } },
      _sum: { quantityTons: true },
    });
    const usedTons = activeBookings._sum.quantityTons || 0;

    return { ...warehouse, availableCapacityTons: warehouse.totalCapacityTons - usedTons };
  }

  // ─── REGISTER WAREHOUSE ───────────────────────────────────────────────────
  // NEW_Changes item 10: operators can now register more than one
  // warehouse (e.g. facilities in different cities) — this used to reject
  // a second registration outright.
  async create(userId: string, dto: CreateWarehouseDto) {
    // Offering insurance without a price made the booking form's insurance
    // option unusable ("has not set an insurance rate yet").
    if (dto.insuranceAvailable && dto.insurancePricePerTonMonth == null) {
      throw new BadRequestException('Set an insurance rate (₨/ton/month) or turn off "insurance available".');
    }
    return this.prisma.warehouseProfile.create({
      data: { userId, ...dto } as any,
    });
  }

  // ─── EDIT WAREHOUSE (operator, own warehouse only) ─────────────────────────
  // NEW_Changes item 10: there was previously no way to change anything
  // after registration — rates, capacity, even a typo in the address were
  // permanent. isVerified/isActive stay admin-only (see adminVerify /
  // adminSetActive) since those are trust/moderation signals, not the
  // operator's own listing content.
  async update(operatorId: string, warehouseId: string, dto: UpdateWarehouseDto) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');

    const willOfferInsurance = dto.insuranceAvailable ?? warehouse.insuranceAvailable;
    const rateAfter = dto.insurancePricePerTonMonth !== undefined ? dto.insurancePricePerTonMonth : warehouse.insurancePricePerTonMonth;
    if (willOfferInsurance && rateAfter == null) {
      throw new BadRequestException('Set an insurance rate (₨/ton/month) or turn off "insurance available".');
    }

    return this.prisma.warehouseProfile.update({
      where: { id: warehouseId },
      data: { ...dto } as any,
    });
  }

  // Resolves the effective rate for a commodity: a per-commodity override
  // if the operator set one, else the warehouse's flat base rate. Shared
  // by bookStorage() (actual charge) and quoteRate() (frontend preview
  // before the depositor submits a booking).
  private resolveRatePerTonMonth(warehouse: { pricePerTonMonth: any; ratesByCommodity: any }, commodity: string): number {
    const overrides = (warehouse.ratesByCommodity || {}) as Record<string, number>;
    const override = overrides[commodity];
    return override !== undefined && override !== null ? Number(override) : Number(warehouse.pricePerTonMonth);
  }

  // ─── RATE QUOTE (no booking created — lets the frontend show a live
  // price, including insurance, before the depositor commits) ────────────────
  async quoteRate(warehouseId: string, commodity: string, quantityTons: number, durationDays: number, includeInsurance?: boolean) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    const monthsDecimal = durationDays / 30;
    const ratePerTonMonth = this.resolveRatePerTonMonth(warehouse, commodity);
    const storageCost = quantityTons * ratePerTonMonth * monthsDecimal;

    let insuranceCost = 0;
    let insuranceAvailable = false;
    if (includeInsurance) {
      if (warehouse.insuranceAvailable && warehouse.insurancePricePerTonMonth != null) {
        insuranceAvailable = true;
        insuranceCost = quantityTons * Number(warehouse.insurancePricePerTonMonth) * monthsDecimal;
      }
    }

    return {
      ratePerTonMonth,
      storageCost,
      insuranceAvailable: warehouse.insuranceAvailable && warehouse.insurancePricePerTonMonth != null,
      insurancePricePerTonMonth: warehouse.insurancePricePerTonMonth,
      insuranceCost,
      totalCost: storageCost + insuranceCost,
    };
  }

  // ─── BOOK STORAGE ─────────────────────────────────────────────────────────
  async bookStorage(depositorId: string, dto: BookStorageDto) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({
      where: { id: dto.warehouseId },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (!warehouse.isActive) throw new BadRequestException('Warehouse is not accepting bookings');

    // Check commodity accepted
    if (!warehouse.commoditiesAccepted.includes(dto.commodity)) {
      throw new BadRequestException(`This warehouse does not accept ${dto.commodity}`);
    }

    // Check minimum duration
    if (dto.durationDays < warehouse.minDurationDays) {
      throw new BadRequestException(`Minimum storage duration is ${warehouse.minDurationDays} days`);
    }

    const entryDate = new Date(dto.entryDate);
    const exitDate = new Date(entryDate);
    exitDate.setDate(exitDate.getDate() + dto.durationDays);

    const monthsDecimal = dto.durationDays / 30;
    const ratePerTonMonth = this.resolveRatePerTonMonth(warehouse, dto.commodity);
    const storageCost = dto.quantityTons * ratePerTonMonth * monthsDecimal;

    // Insurance must actually be priced before it can be selected — a
    // checkbox with no rate behind it was exactly the bug reported
    // ("no price is either visible for warehouse provider or the
    // customer"). Refusing here is better than silently charging Rs. 0
    // for coverage that doesn't really exist.
    let insuranceCost = 0;
    if (dto.includeInsurance) {
      if (!warehouse.insuranceAvailable || warehouse.insurancePricePerTonMonth == null) {
        throw new BadRequestException('This warehouse has not set an insurance rate yet, so insurance cannot be added to this booking.');
      }
      insuranceCost = dto.quantityTons * Number(warehouse.insurancePricePerTonMonth) * monthsDecimal;
    }
    const totalCost = storageCost + insuranceCost;

    // Capacity check + insert run in ONE transaction, with the warehouse row
    // locked, so two simultaneous requests can't both pass the check and
    // oversell the warehouse.
    const booking = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM warehouse_profiles WHERE id = ${dto.warehouseId} FOR UPDATE`;
      const activeBookings = await tx.storageBooking.aggregate({
        where: { warehouseId: dto.warehouseId, status: { in: CAPACITY_HELD_STATUSES } },
        _sum: { quantityTons: true },
      });
      const usedTons = activeBookings._sum.quantityTons || 0;
      const available = warehouse.totalCapacityTons - usedTons;
      if (dto.quantityTons > available) {
        throw new BadRequestException(`Only ${available} tons available. Requested ${dto.quantityTons} tons.`);
      }
      return tx.storageBooking.create({
      data: {
        warehouseId: dto.warehouseId,
        depositorId,
        commodity: dto.commodity,
        variety: dto.variety,
        quantityTons: dto.quantityTons,
        packagingType: dto.packagingType,
        entryDate,
        durationDays: dto.durationDays,
        exitDate,
        pricePerTon: ratePerTonMonth,
        insuranceCost: dto.includeInsurance ? insuranceCost : null,
        totalCost,
        includeInsurance: dto.includeInsurance || false,
        notes: dto.notes,
        status: BookingStatus.REQUESTED,
      },
      include: {
        warehouse: { select: { name: true, city: true, managerPhone: true } },
      },
    });
    });

    // Tell the warehouse operator a request is waiting — previously they
    // only found out by opening their dashboard.
    await this.notifications.notify({
      userId: warehouse.userId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: 'New storage booking request',
      body: `${withBookingReference(booking).bookingReference}: ${dto.quantityTons} tons of ${dto.commodity} for ${dto.durationDays} days at ${booking.warehouse.name}.`,
      data: { link: '/warehouse-portal', bookingId: booking.id },
    });

    // No ledger row at request time: nothing has been paid. The storage fee
    // is booked when the invoice payment is confirmed (confirmInvoicePayment).

    return {
      booking: withBookingReference(booking),
      message: 'Booking request sent to the warehouse. You\'ll be notified once they accept or decline it.',
      nextSteps: [
        'The warehouse operator will review and accept or decline your request',
        'Once accepted, deliver your commodity to the warehouse by the entry date',
        'Warehouse staff will weigh and quality-check on arrival',
        'Digital Warehouse Receipt (DWR) will be issued within 24 hours of arrival',
        'You can then use the DWR to apply for bank financing',
      ],
    };
  }

  // ─── MY BOOKINGS (buyer/depositor) ────────────────────────────────────────
  async getMyBookings(depositorId: string) {
    const bookings = await this.prisma.storageBooking.findMany({
      where: { depositorId },
      include: {
        warehouse: { select: { name: true, city: true, province: true, managerPhone: true } },
        _count: { select: { messages: true } },
        receipt: { select: { id: true, receiptNumber: true, status: true, lien: { select: { id: true, bankName: true, loanAmount: true, status: true, placedAt: true } } } },
        invoice: { select: { id: true, invoiceNumber: true, status: true, totalAmount: true } },
        goodsReceiptNote: { select: { id: true, grnNumber: true } },
        gateOutPasses: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
    return withBookingReferences(bookings);
  }

  // ─── SINGLE BOOKING (buyer, operator, or admin) ───────────────────────────
  async getBooking(bookingId: string, userId: string, role: string) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: {
        warehouse: { select: { id: true, name: true, city: true, province: true, managerPhone: true, userId: true } },
        depositor: { select: { id: true, phoneNumber: true, email: true, profile: { select: { fullName: true, businessName: true, city: true, province: true } } } },
        receipt: { include: { lien: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const isOwner = booking.depositorId === userId;
    const isOperator = booking.warehouse.userId === userId;
    const isAdmin = role === 'ADMIN' || role === 'MODERATOR';
    if (!isOwner && !isOperator && !isAdmin) throw new ForbiddenException('Access denied');
    return withBookingReference(booking);
  }

  // ─── WAREHOUSE ACCEPTS A REQUESTED BOOKING ────────────────────────────────
  async acceptBooking(operatorId: string, bookingId: string) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: { warehouse: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');
    assertTransition(booking.status, BookingStatus.ACCEPTED);

    const updated = await this.prisma.storageBooking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.ACCEPTED, acceptedAt: new Date() },
      include: { warehouse: { select: { name: true, city: true } } },
    });
    await this.notifications.notify({
      userId: booking.depositorId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: 'Booking accepted',
      body: `${withBookingReference(updated).bookingReference} was accepted by ${updated.warehouse.name}. Deliver your goods by the entry date.`,
      data: { link: '/warehouse', bookingId },
    });
    return withBookingReference(updated);
  }

  // ─── WAREHOUSE REJECTS A REQUESTED BOOKING ────────────────────────────────
  async rejectBooking(operatorId: string, bookingId: string, dto: RejectBookingDto) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: { warehouse: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');
    assertTransition(booking.status, BookingStatus.REJECTED);

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.storageBooking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.REJECTED, rejectedAt: new Date(), rejectionReason: dto.reason },
        include: { warehouse: { select: { name: true, city: true } } },
      });
      await this.refundIfPaid(tx, booking, 'was declined');
      return u;
    });
    await this.notifications.notify({
      userId: booking.depositorId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: 'Booking declined',
      body: `${withBookingReference(updated).bookingReference} was declined by ${updated.warehouse.name}: ${dto.reason}`,
      data: { link: '/warehouse', bookingId },
    });
    return withBookingReference(updated);
  }

  // ─── DEPOSITOR OR OPERATOR CANCELS BEFORE GOODS ARRIVE ────────────────────
  async cancelBooking(userId: string, role: string, bookingId: string, dto: CancelBookingDto) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: { warehouse: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const isOwner = booking.depositorId === userId;
    const isOperator = booking.warehouse.userId === userId;
    const isAdmin = role === 'ADMIN';
    if (!isOwner && !isOperator && !isAdmin) throw new ForbiddenException('Not your booking');
    assertTransition(booking.status, BookingStatus.CANCELLED);

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.storageBooking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CANCELLED, cancelledAt: new Date(), cancelReason: dto.reason },
        include: { warehouse: { select: { name: true, city: true } } },
      });
      await this.refundIfPaid(tx, booking, 'was cancelled');
      return u;
    });
    return withBookingReference(updated);
  }

  // ─── OPERATOR MARKS A BOOKING COMPLETE (goods released) ───────────────────
  async completeBooking(operatorId: string, bookingId: string) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: { warehouse: true, receipt: { include: { lien: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');
    assertTransition(booking.status, BookingStatus.COMPLETED);
    if (booking.receipt?.lien && LIEN_BLOCKING_STATUSES.includes(booking.receipt.lien.status)) {
      throw new BadRequestException('This receipt still has a pending or active bank lien — it must be cleared before the booking can be completed');
    }
    // Goods must actually have been released: completing a booking without
    // an approved gate-out pass would close it while the stock is still
    // on the floor (or released with no authorisation on record).
    const approvedPass = await this.prisma.gateOutPass.findFirst({
      where: { bookingId, status: 'APPROVED' as any },
      select: { id: true },
    });
    if (!approvedPass) {
      throw new BadRequestException('An approved gate-out pass is required before this booking can be completed — request release and have the depositor approve it first');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.storageBooking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.COMPLETED, completedAt: new Date() },
        include: { warehouse: { select: { name: true, city: true } } },
      }),
      ...(booking.receipt && booking.receipt.status === ReceiptStatus.ACTIVE
        ? [this.prisma.warehouseReceipt.update({
            where: { id: booking.receipt.id },
            data: { status: ReceiptStatus.RELEASED },
          })]
        : []),
    ]);
    return withBookingReference(updated);
  }

  // ─── ISSUE RECEIPT (warehouse operator) ───────────────────────────────────
  async issueReceipt(
    operatorId: string,
    bookingId: string,
    qualityMetrics: any,
    actualQuantityTons: number,
  ) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: { warehouse: true, receipt: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');
    if (booking.receipt) throw new BadRequestException('Receipt already issued for this booking');
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        `Booking must be Accepted before a receipt can be issued (current status: ${booking.status}). Accept the booking first.`,
      );
    }

    // Collateral value comes from the admin-maintained commodity price table
    // (Settings). With no price configured the receipt is still issued — the
    // operator must not be blocked — but its value is 0 ("valuation pending"):
    // no loan can be applied against it until an admin sets the price, at
    // which point SettingsService.setCommodityPrice values it automatically.
    const pricePerTon = await this.settings.getCommodityPricePerTon(booking.commodity);
    const marketValue = pricePerTon ? Math.round(actualQuantityTons * pricePerTon * 100) / 100 : 0;

    // Receipt + number + booking ACTIVE + GRN happen atomically: either the
    // goods are fully received into the system or nothing is.
    try {
      // (cast: the options argument isn't in the sandbox's Prisma shim typings)
      return await (this.prisma as any).$transaction(async (tx: any) => {
        const include = {
          warehouse: { select: { name: true, city: true } },
          owner: { select: { profile: { select: { fullName: true } } } },
        };
        // receiptNumber is UNIQUE, so the temporary value must be unique too
        // (a shared 'PENDING' string would collide under concurrency).
        const seqHolder = await tx.warehouseReceipt.create({
          data: {
            receiptNumber: `TMP-${uuidv4()}`,
            bookingId,
            warehouseId: booking.warehouseId,
            ownerId: booking.depositorId,
            commodity: booking.commodity,
            variety: booking.variety,
            quantityTons: actualQuantityTons,
            qualityMetrics,
            entryDate: booking.entryDate,
            expiryDate: booking.exitDate,
            marketValue,
            status: ReceiptStatus.ACTIVE,
          },
        });
        const receipt = await tx.warehouseReceipt.update({
          where: { id: seqHolder.id },
          data: { receiptNumber: formatDocumentNumber('WR', seqHolder.receiptSeq, seqHolder.createdAt) },
          include,
        });

        // Goods have physically arrived and been weighed/quality-checked —
        // booking moves from ACCEPTED to ACTIVE (guarded against a race).
        const moved = await tx.storageBooking.updateMany({
          where: { id: bookingId, status: BookingStatus.ACCEPTED },
          data: { status: BookingStatus.ACTIVE },
        });
        if (moved.count === 0) throw new BadRequestException('This booking was just updated — refresh and try again');

        // A formal Goods Receipt Note is issued at exactly this moment.
        // Distinct from the WarehouseReceipt above (collateral document).
        await this.issueGoodsReceiptNote(tx, booking, operatorId, actualQuantityTons, qualityMetrics);

        return receipt;
      }, { timeout: 30000 });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('Receipt already issued for this booking');
      throw e;
    }
  }

  private async issueGoodsReceiptNote(
    tx: any,
    booking: { id: string; warehouseId: string; depositorId: string; commodity: string; variety: string | null },
    operatorId: string,
    quantityTons: number,
    qualityMetrics: any,
  ) {
    const [warehouse, depositor] = await Promise.all([
      tx.warehouseProfile.findUnique({ where: { id: booking.warehouseId } }),
      tx.user.findUnique({ where: { id: booking.depositorId }, select: { profile: { select: { fullName: true } } } }),
    ]);

    const qualityNotes = qualityMetrics == null ? null
      : typeof qualityMetrics === 'string' ? qualityMetrics
      : JSON.stringify(qualityMetrics);

    // Reserve the seq first so the PDF can embed the real grnNumber. The
    // placeholder is unique per call (grnNumber is UNIQUE).
    const seqHolder = await tx.goodsReceiptNote.create({
      data: {
        grnNumber: `TMP-${uuidv4()}`,
        bookingId: booking.id,
        warehouseId: booking.warehouseId,
        depositorId: booking.depositorId,
        commodity: booking.commodity,
        variety: booking.variety,
        quantityTons,
        qualityNotes,
        receivedById: operatorId,
        s3Key: '',
      },
    });
    const grnNumber = formatDocumentNumber('GRN', seqHolder.grnSeq, seqHolder.receivedAt);

    const pdfBuffer = await renderPdfDocument({
      documentTitle: 'GOODS RECEIPT NOTE',
      documentNumber: grnNumber,
      issuedAt: seqHolder.receivedAt,
      fromLines: [warehouse?.name || 'Warehouse', warehouse?.address || '', `${warehouse?.city || ''}, ${warehouse?.province || ''}`],
      toLines: [depositor?.profile?.fullName || 'Depositor'],
      meta: [
        ['Commodity', booking.variety ? `${booking.commodity} (${booking.variety})` : booking.commodity],
        ['Quantity Received', `${quantityTons} tons`],
        ...(qualityNotes ? [['Quality Notes', qualityNotes] as [string, string]] : []),
      ],
      lineItems: [{ label: 'Goods received and accepted into storage in good order, subject to the quality notes above (if any).' }],
      footerNote: 'This note confirms physical receipt of goods only. It is not a warehouse receipt / collateral document — see your Digital Warehouse Receipt for that.',
    });

    const s3Key = `warehouse-documents/grn-${seqHolder.id}.pdf`;
    await this.storage.putObject(s3Key, pdfBuffer, 'application/pdf');

    return tx.goodsReceiptNote.update({
      where: { id: seqHolder.id },
      data: { grnNumber, s3Key },
    });
  }

  // ─── INVOICE (warehouse operator generates & "sends" to the depositor) ─────
  // NEW_Changes item 10. One invoice per booking (see schema comment on
  // WarehouseInvoice.bookingId) — amounts are copied from the booking's
  // already-computed totalCost/insuranceCost rather than recalculated, so
  // the invoice can't drift from what bookStorage() actually charged.
  async generateInvoice(operatorId: string, bookingId: string) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      include: { warehouse: true, invoice: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');
    if (booking.invoice) throw new BadRequestException('An invoice has already been generated for this booking');
    if (!INVOICEABLE_STATUSES.includes(booking.status)) {
      throw new BadRequestException(`An invoice can only be issued for an accepted booking (current status: ${booking.status}).`);
    }

    const [depositor] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: booking.depositorId }, select: { profile: { select: { fullName: true, address: true, city: true } } } }),
    ]);

    const storageCost = Number(booking.totalCost) - Number(booking.insuranceCost || 0);

    const seqHolder = await this.prisma.warehouseInvoice.create({
      data: {
        invoiceNumber: `TMP-${uuidv4()}`,
        bookingId: booking.id,
        warehouseId: booking.warehouseId,
        depositorId: booking.depositorId,
        storageCost,
        insuranceCost: booking.insuranceCost,
        totalAmount: booking.totalCost,
        s3Key: '',
      },
    });
    const invoiceNumber = formatDocumentNumber('INV', seqHolder.invoiceSeq, seqHolder.issuedAt);

    const lineItems: PdfLineItem[] = [
      { label: `Storage — ${booking.commodity}${booking.variety ? ` (${booking.variety})` : ''}, ${booking.quantityTons} tons × ${booking.durationDays} days`, amount: storageCost },
    ];
    if (booking.insuranceCost) lineItems.push({ label: 'Storage insurance', amount: Number(booking.insuranceCost) });

    const pdfBuffer = await renderPdfDocument({
      documentTitle: 'STORAGE INVOICE',
      documentNumber: invoiceNumber,
      issuedAt: seqHolder.issuedAt,
      fromLines: [booking.warehouse.name, booking.warehouse.address, `${booking.warehouse.city}, ${booking.warehouse.province}`],
      toLines: [depositor?.profile?.fullName || 'Depositor', depositor?.profile?.address || '', depositor?.profile?.city || ''],
      meta: [['Booking', formatBookingReference((booking as any).bookingSeq, booking.createdAt) || booking.id]],
      lineItems,
      totalLabel: 'TOTAL DUE',
      totalAmount: Number(booking.totalCost),
      footerNote: 'Payment confirmation will be recorded by the warehouse once received. This is not a receipt of payment.',
    });

    const s3Key = `warehouse-documents/invoice-${seqHolder.id}.pdf`;
    await this.storage.putObject(s3Key, pdfBuffer, 'application/pdf');

    return this.prisma.warehouseInvoice.update({
      where: { id: seqHolder.id },
      data: { invoiceNumber, s3Key },
    });
  }

  // Manual payment confirmation — see InvoiceStatus schema comment for why
  // there's no gateway callback here. Operator (of that warehouse) or any
  // admin/moderator can confirm.
  async confirmInvoicePayment(userId: string, userRole: string, invoiceId: string, paymentReference?: string) {
    const invoice = await this.prisma.warehouseInvoice.findUnique({
      where: { id: invoiceId },
      include: { warehouse: true, booking: { select: { status: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    if (invoice.warehouse.userId !== userId && !isAdmin) throw new ForbiddenException('Not authorized to confirm this payment');
    if (invoice.status === 'PAID') throw new BadRequestException('This invoice is already marked as paid');
    if (
  invoice.booking &&
  (
    invoice.booking.status === BookingStatus.CANCELLED ||
    invoice.booking.status === BookingStatus.REJECTED
  )
) {
      throw new BadRequestException(`This booking was ${invoice.booking.status.toLowerCase()} — its invoice can no longer be paid.`);
    }

    // The money is booked in the ledger HERE — the moment payment is
    // confirmed — and the invoice flip is guarded so a double-click can't
    // book it twice.
    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.warehouseInvoice.updateMany({
        where: { id: invoiceId, status: 'UNPAID' },
        data: { status: 'PAID', paidAt: new Date(), paymentReference, confirmedById: userId },
      });
      if (flipped.count === 0) throw new BadRequestException('This invoice is already marked as paid');

      const storageAmount = Number(invoice.storageCost);
      const insuranceAmount = Number(invoice.insuranceCost || 0);
      const rows: any[] = [{
        userId: invoice.depositorId,
        type: TransactionType.STORAGE_FEE,
        amount: storageAmount,
        description: `Storage fee paid — invoice ${invoice.invoiceNumber}`,
        referenceId: invoice.bookingId,
        referenceType: 'storage',
      }];
      if (insuranceAmount > 0) {
        rows.push({
          userId: invoice.depositorId,
          type: TransactionType.INSURANCE_PREMIUM,
          amount: insuranceAmount,
          description: `Storage insurance paid — invoice ${invoice.invoiceNumber}`,
          referenceId: invoice.bookingId,
          referenceType: 'storage',
        });
      }
      await tx.transaction.createMany({ data: rows });
      return tx.warehouseInvoice.findUnique({ where: { id: invoiceId } });
    });
  }

  async getInvoice(userId: string, userRole: string, invoiceId: string) {
    const invoice = await this.prisma.warehouseInvoice.findUnique({
      where: { id: invoiceId },
      include: { warehouse: { select: { name: true, city: true, userId: true } }, booking: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    if (invoice.depositorId !== userId && invoice.warehouse.userId !== userId && !isAdmin) {
      throw new ForbiddenException('Access denied');
    }
    return { ...invoice, downloadUrl: await this.storage.getPresignedUrl(invoice.s3Key, 600) };
  }

  async getMyInvoices(depositorId: string) {
    return this.prisma.warehouseInvoice.findMany({
      where: { depositorId },
      include: { warehouse: { select: { name: true, city: true } } },
      orderBy: { issuedAt: 'desc' },
    });
  }

  async getOperatorInvoices(operatorId: string) {
    const warehouses = await this.prisma.warehouseProfile.findMany({ where: { userId: operatorId }, select: { id: true } });
    return this.prisma.warehouseInvoice.findMany({
      where: { warehouseId: { in: warehouses.map((w) => w.id) } },
      include: { depositor: { select: { profile: { select: { fullName: true } } } }, warehouse: { select: { name: true } } },
      orderBy: { issuedAt: 'desc' },
    });
  }

  // ─── BOOKING MESSAGES (depositor <-> warehouse operator) ──────────────────
  // One thread per booking. Participants: the depositor, the operator who
  // owns the warehouse, and (read-only) admins/moderators.
  private async assertBookingParticipant(bookingId: string, userId: string, role: string) {
    const booking = await this.prisma.storageBooking.findUnique({
      where: { id: bookingId },
      select: { id: true, depositorId: true, status: true, bookingSeq: true, createdAt: true, warehouse: { select: { userId: true, name: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const isDepositor = booking.depositorId === userId;
    const isOperator = booking.warehouse.userId === userId;
    const isAdmin = role === 'ADMIN' || role === 'MODERATOR';
    if (!isDepositor && !isOperator && !isAdmin) throw new ForbiddenException('Access denied');
    return { booking, isDepositor, isOperator, isAdmin };
  }

  async getBookingMessages(bookingId: string, userId: string, role: string) {
    await this.assertBookingParticipant(bookingId, userId, role);
    const rows = await this.prisma.bookingMessage.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, profile: { select: { fullName: true, businessName: true } } } } },
    });
    return rows.map(m => ({
      id: m.id,
      kind: m.kind,
      body: m.body,
      createdAt: m.createdAt,
      senderId: m.senderId,
      senderName: m.sender?.profile?.businessName || m.sender?.profile?.fullName || 'User',
      mine: m.senderId === userId,
    }));
  }

  async postBookingMessage(bookingId: string, userId: string, role: string, dto: PostBookingMessageDto) {
    const { booking, isOperator, isDepositor } = await this.assertBookingParticipant(bookingId, userId, role);
    if (!isOperator && !isDepositor) throw new ForbiddenException('Only the depositor or the warehouse can post messages');
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Message cannot be empty');
    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.REJECTED) {
      throw new BadRequestException(`This booking is ${booking.status.toLowerCase()} — the conversation is closed.`);
    }
    const kind = dto.kind === 'INFO_REQUEST' && isOperator ? 'INFO_REQUEST' : 'MESSAGE';
    const created = await this.prisma.bookingMessage.create({
      data: { bookingId, senderId: userId, kind: kind as any, body },
    });
    const ref = formatBookingReference(booking.bookingSeq, booking.createdAt);
    await this.notifications.notify({
      userId: isOperator ? booking.depositorId : booking.warehouse.userId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: kind === 'INFO_REQUEST' ? 'Warehouse needs more information' : 'New message on your booking',
      body: `${ref}: ${body.length > 120 ? body.slice(0, 117) + '…' : body}`,
      data: { link: isOperator ? '/warehouse' : '/warehouse-portal', bookingId },
    });
    return created;
  }

  // ─── GOODS RECEIPT NOTE (read access — issued automatically by
  // issueReceipt() above) ─────────────────────────────────────────────────────
  async getGrn(userId: string, userRole: string, grnId: string) {
    const grn = await this.prisma.goodsReceiptNote.findUnique({
      where: { id: grnId },
      include: { warehouse: { select: { name: true, city: true, userId: true } } },
    });
    if (!grn) throw new NotFoundException('Goods Receipt Note not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    if (grn.depositorId !== userId && grn.warehouse.userId !== userId && !isAdmin) {
      throw new ForbiddenException('Access denied');
    }
    return { ...grn, downloadUrl: await this.storage.getPresignedUrl(grn.s3Key, 600) };
  }

  // ─── GATE OUT PASS ──────────────────────────────────────────────────────────
  // NEW_Changes item 10: the warehouse operator requests release of goods,
  // then either the depositor (goods owner) or an admin/moderator must
  // approve before the pass is actually issued.
  async requestGateOut(operatorId: string, bookingId: string, quantityTons?: number, requestNote?: string) {
    const booking = await this.prisma.storageBooking.findUnique({ where: { id: bookingId }, include: { warehouse: true } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');
    if (booking.status !== BookingStatus.ACTIVE) {
      throw new BadRequestException(`Goods must be in active storage before a gate-out pass can be requested (current status: ${booking.status}).`);
    }
    const activeLien = await this.getActiveLien(bookingId);
    if (activeLien) throw new BadRequestException(this.lienBlockMessage(activeLien, 'A gate-out pass cannot be requested'));
    const existingPending = await this.prisma.gateOutPass.findFirst({ where: { bookingId, status: 'PENDING' } });
    if (existingPending) throw new BadRequestException('There is already a pending gate-out request for this booking');

    const created = await this.prisma.gateOutPass.create({
      data: {
        bookingId,
        warehouseId: booking.warehouseId,
        depositorId: booking.depositorId,
        quantityTons: quantityTons ?? booking.quantityTons,
        requestedById: operatorId,
        requestNote,
      },
    });
    await this.notifications.notify({
      userId: booking.depositorId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: 'Release of your goods requested',
      body: `${booking.warehouse.name} has requested your approval to release ${created.quantityTons} tons of ${booking.commodity}.`,
      data: { link: '/warehouse', bookingId },
    });
    return created;
  }

  async approveGateOut(userId: string, userRole: string, passId: string) {
    const pass = await this.prisma.gateOutPass.findUnique({ where: { id: passId }, include: { warehouse: true, booking: true } });
    if (!pass) throw new NotFoundException('Gate-out request not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    const isDepositor = pass.depositorId === userId;
    if (!isAdmin && !isDepositor) throw new ForbiddenException('Only the depositor or an admin can approve a gate-out request');
    if (pass.status !== 'PENDING') throw new BadRequestException(`This request has already been ${pass.status.toLowerCase()}`);
    // A lien may have been placed after the request was raised — re-check
    // so a pass can't be issued for goods that are now the bank's collateral.
    const activeLien = await this.getActiveLien(pass.bookingId);
    if (activeLien) throw new BadRequestException(this.lienBlockMessage(activeLien, 'The gate-out pass cannot be issued'));

    const approvedAt = new Date();
    const passNumber = formatDocumentNumber('GOP', pass.passSeq, approvedAt);

    const [depositor] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: pass.depositorId }, select: { profile: { select: { fullName: true } } } }),
    ]);

    const pdfBuffer = await renderPdfDocument({
      documentTitle: 'GATE OUT PASS',
      documentNumber: passNumber,
      issuedAt: approvedAt,
      fromLines: [pass.warehouse.name, pass.warehouse.address, `${pass.warehouse.city}, ${pass.warehouse.province}`],
      toLines: [depositor?.profile?.fullName || 'Depositor'],
      meta: [
        ['Commodity', pass.booking.variety ? `${pass.booking.commodity} (${pass.booking.variety})` : pass.booking.commodity],
        ['Quantity Authorized', `${pass.quantityTons} tons`],
        ['Approved By', isAdmin ? 'AgriConnect Admin' : 'Depositor (goods owner)'],
      ],
      lineItems: [{ label: 'This pass authorizes the bearer to remove the above quantity of goods from the warehouse.' }],
      footerNote: 'Present this pass, along with valid ID, to warehouse security to collect the goods.',
    });

    const s3Key = `warehouse-documents/gate-pass-${pass.id}.pdf`;
    await this.storage.putObject(s3Key, pdfBuffer, 'application/pdf');

    const approved = await this.prisma.gateOutPass.update({
      where: { id: passId },
      data: {
        status: 'APPROVED',
        approvedById: userId,
        approverRole: isAdmin ? 'ADMIN' : 'DEPOSITOR',
        approvedAt,
        passNumber,
        s3Key,
      },
    });
    await this.notifications.notify({
      userId: pass.warehouse.userId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: 'Gate-out approved',
      body: `${passNumber} was approved for ${pass.quantityTons} tons of ${pass.booking.commodity}. You can release the goods.`,
      data: { link: '/warehouse-portal', bookingId: pass.bookingId },
    });
    return approved;
  }

  async rejectGateOut(userId: string, userRole: string, passId: string, rejectionNote?: string) {
    const pass = await this.prisma.gateOutPass.findUnique({ where: { id: passId }, include: { warehouse: { select: { userId: true } } } });
    if (!pass) throw new NotFoundException('Gate-out request not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    const isDepositor = pass.depositorId === userId;
    if (!isAdmin && !isDepositor) throw new ForbiddenException('Only the depositor or an admin can reject a gate-out request');
    if (pass.status !== 'PENDING') throw new BadRequestException(`This request has already been ${pass.status.toLowerCase()}`);

    const rejected = await this.prisma.gateOutPass.update({
      where: { id: passId },
      data: { status: 'REJECTED', approvedById: userId, approverRole: isAdmin ? 'ADMIN' : 'DEPOSITOR', approvedAt: new Date(), rejectionNote },
    });
    await this.notifications.notify({
      userId: pass.warehouse.userId,
      type: NotificationType.WAREHOUSE_UPDATE,
      title: 'Gate-out request rejected',
      body: `The release request was rejected${rejectionNote ? `: ${rejectionNote}` : '.'}`,
      data: { link: '/warehouse-portal', bookingId: pass.bookingId },
    });
    return rejected;
  }

  async getGateOutPass(userId: string, userRole: string, passId: string) {
    const pass = await this.prisma.gateOutPass.findUnique({
      where: { id: passId },
      include: { warehouse: { select: { name: true, city: true, userId: true } }, booking: true },
    });
    if (!pass) throw new NotFoundException('Gate-out request not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    if (pass.depositorId !== userId && pass.warehouse.userId !== userId && !isAdmin) {
      throw new ForbiddenException('Access denied');
    }
    return { ...pass, downloadUrl: pass.s3Key ? await this.storage.getPresignedUrl(pass.s3Key, 600) : null };
  }

  async getMyGateOutPasses(depositorId: string) {
    return this.prisma.gateOutPass.findMany({
      where: { depositorId },
      include: { warehouse: { select: { name: true, city: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOperatorGateOutPasses(operatorId: string) {
    const warehouses = await this.prisma.warehouseProfile.findMany({ where: { userId: operatorId }, select: { id: true } });
    return this.prisma.gateOutPass.findMany({
      where: { warehouseId: { in: warehouses.map((w) => w.id) } },
      include: { depositor: { select: { profile: { select: { fullName: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── MY RECEIPTS ──────────────────────────────────────────────────────────
  async getMyReceipts(ownerId: string) {
    const receipts = await this.prisma.warehouseReceipt.findMany({
      where: { ownerId },
      include: {
        warehouse: { select: { name: true, city: true, province: true, managerPhone: true } },
        lien: true,
        insurance: true,
        booking: { select: { totalCost: true, includeInsurance: true, bookingSeq: true, createdAt: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return receipts.map((r) => ({
      ...r,
      booking: r.booking ? withBookingReference(r.booking) : null,
    }));
  }

  // ─── SINGLE RECEIPT ───────────────────────────────────────────────────────
  async getReceipt(receiptId: string, userId: string) {
    const receipt = await this.prisma.warehouseReceipt.findUnique({
      where: { id: receiptId },
      include: {
        warehouse: true,
        owner: { select: { profile: { select: { fullName: true, city: true } } } },
        lien: true,
        insurance: true,
        booking: true,
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.ownerId !== userId) throw new ForbiddenException('Access denied');
    return { ...receipt, booking: receipt.booking ? withBookingReference(receipt.booking) : null };
  }

  // ─── APPLY FOR BANK LIEN ──────────────────────────────────────────────────
  async applyLien(ownerId: string, dto: ApplyLienDto) {
    const receipt = await this.prisma.warehouseReceipt.findUnique({
      where: { id: dto.receiptId },
      include: { lien: true, warehouse: { select: { userId: true, name: true } } },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.ownerId !== ownerId) throw new ForbiddenException('Not your receipt');
    if (receipt.status !== ReceiptStatus.ACTIVE) throw new BadRequestException('Receipt must be Active to apply for a lien');
    if (receipt.lien && LIEN_BLOCKING_STATUSES.includes(receipt.lien.status)) {
      throw new BadRequestException('A loan application or lien already exists on this receipt');
    }

    // Collateral value must come from the admin price table. 0 = no price
    // was configured when the receipt was issued ("valuation pending").
    if (!(Number(receipt.marketValue) > 0)) {
      throw new BadRequestException(
        `The collateral value of ${receipt.commodity} has not been set yet, so a loan cannot be assessed. An AgriConnect admin needs to set the commodity price — please try again later.`,
      );
    }
    const maxLoan = Number(receipt.marketValue) * 0.70;
    if (dto.loanAmount > maxLoan) {
      throw new BadRequestException(`Maximum eligible loan is ₨${maxLoan.toLocaleString()} (70% of commodity value)`);
    }

    // One transaction: freeze the receipt (guarded, so a double-tap can't
    // create two applications) and record the application as PENDING. No
    // loan exists yet — nothing is booked in the ledger until an admin
    // confirms it (see confirmLien).
    const lien = await this.prisma.$transaction(async (tx) => {
      const guarded = await tx.warehouseReceipt.updateMany({
        where: { id: dto.receiptId, status: ReceiptStatus.ACTIVE },
        data: { status: ReceiptStatus.UNDER_LIEN },
      });
      if (guarded.count === 0) {
        throw new BadRequestException('This receipt is no longer available for a new lien application');
      }
      // A previous REJECTED / WITHDRAWN / RELEASED application occupies the
      // unique receiptId slot — reuse that row for the new application.
      if (receipt.lien) {
        return tx.bankLien.update({
          where: { id: receipt.lien.id },
          data: {
            bankName: dto.bankName, loanPurpose: dto.loanPurpose, loanAmount: dto.loanAmount,
            interestRate: dto.interestRate, tenureMonths: dto.tenureMonths, loanOfficer: dto.loanOfficer,
            status: LienStatus.PENDING, placedAt: new Date(), releasedAt: null, releaseNote: null,
            loanRefNo: null, decidedById: null, decidedAt: null, decisionNote: null,
          },
        });
      }
      return tx.bankLien.create({
        data: {
          receiptId: dto.receiptId,
          bankName: dto.bankName,
          loanPurpose: dto.loanPurpose,
          loanAmount: dto.loanAmount,
          interestRate: dto.interestRate,
          tenureMonths: dto.tenureMonths,
          loanOfficer: dto.loanOfficer,
          status: LienStatus.PENDING,
        },
      });
    });

    // Notify: the warehouse (hold the goods), the owner (confirmation), and
    // admins/moderators (there is an application waiting for a decision).
    const [owner, reviewers] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: ownerId }, select: { profile: { select: { fullName: true, businessName: true } } } }),
      this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'MODERATOR'] }, isActive: true }, select: { id: true } }),
    ]);
    const ownerName = owner?.profile?.businessName || owner?.profile?.fullName || 'The depositor';
    await this.notifications.notifyMany([
      {
        userId: receipt.warehouse.userId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Loan application on stored goods',
        body: `${ownerName} applied for a ₨${dto.loanAmount.toLocaleString()} loan from ${dto.bankName} against receipt ${receipt.receiptNumber} (${receipt.commodity}, ${receipt.quantityTons} t). Do not release these goods — gate-out is blocked while the application is pending and while any lien is active.`,
        data: { link: '/warehouse-portal', receiptId: receipt.id, lienId: lien.id },
      },
      {
        userId: ownerId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Loan application submitted',
        body: `Your application for ₨${dto.loanAmount.toLocaleString()} from ${dto.bankName} against receipt ${receipt.receiptNumber} is awaiting confirmation. The goods are on hold at ${receipt.warehouse.name} until it is decided. You can withdraw it any time before confirmation.`,
        data: { link: '/warehouse', receiptId: receipt.id, lienId: lien.id },
      },
      ...reviewers.map((r) => ({
        userId: r.id,
        type: NotificationType.LOAN_UPDATE,
        title: 'Loan application awaiting confirmation',
        body: `${ownerName} — ₨${dto.loanAmount.toLocaleString()} from ${dto.bankName} against receipt ${receipt.receiptNumber}.`,
        data: { link: '/admin', lienId: lien.id },
      })),
    ]);

    return {
      lien,
      message: 'Loan application submitted. It becomes an active lien once AgriConnect confirms it with the bank.',
      nextSteps: [
        `${dto.bankName} / AgriConnect will review and confirm your application`,
        'Your goods are on hold at the warehouse while it is pending',
        'You can withdraw the application any time before it is confirmed',
        'Once confirmed, the lien is active until the bank records clearance after repayment',
      ],
    };
  }

  // ─── DEPOSITOR WITHDRAWS A PENDING APPLICATION ────────────────────────────
  async withdrawLien(lienId: string, ownerId: string) {
    const lien = await this.prisma.bankLien.findUnique({
      where: { id: lienId },
      include: { receipt: { include: { warehouse: { select: { userId: true } } } } },
    });
    if (!lien) throw new NotFoundException('Application not found');
    if (lien.receipt.ownerId !== ownerId) throw new ForbiddenException('Not your application');
    if (lien.status !== LienStatus.PENDING) {
      throw new BadRequestException(`Only a pending application can be withdrawn (this one is ${lien.status.toLowerCase()})`);
    }

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.bankLien.updateMany({
        where: { id: lienId, status: LienStatus.PENDING },
        data: { status: LienStatus.WITHDRAWN, decidedAt: new Date(), decisionNote: 'Withdrawn by depositor' },
      });
      if (res.count === 0) throw new BadRequestException('This application was just decided — refresh and check its status');
      await tx.warehouseReceipt.updateMany({
        where: { id: lien.receiptId, status: ReceiptStatus.UNDER_LIEN },
        data: { status: ReceiptStatus.ACTIVE },
      });
    });

    await this.notifications.notify({
      userId: lien.receipt.warehouse.userId,
      type: NotificationType.LOAN_UPDATE,
      title: 'Loan application withdrawn',
      body: `The loan application on receipt ${lien.receipt.receiptNumber} was withdrawn. The hold on these goods is lifted.`,
      data: { link: '/warehouse-portal', receiptId: lien.receiptId },
    });
    return { message: 'Application withdrawn. Your goods are no longer on hold.' };
  }

  // ─── ADMIN: LIEN APPLICATIONS QUEUE ───────────────────────────────────────
  async adminListLiens(status?: string) {
    return this.prisma.bankLien.findMany({
      where: status ? { status: status as LienStatus } : undefined,
      include: {
        receipt: {
          select: {
            id: true, receiptNumber: true, commodity: true, quantityTons: true, marketValue: true,
            warehouse: { select: { name: true, city: true } },
            owner: { select: { id: true, phoneNumber: true, profile: { select: { fullName: true, businessName: true } } } },
          },
        },
      },
      orderBy: { placedAt: 'desc' },
    });
  }

  // ─── ADMIN / MODERATOR CONFIRMS A LIEN (acting for the bank) ──────────────
  // Before this, a depositor's application became an ACTIVE lien — and a
  // LOAN_DISBURSEMENT ledger row — instantly, with no bank involved.
  async confirmLien(lienId: string, deciderId: string, dto: ConfirmLienDto) {
    const lien = await this.prisma.bankLien.findUnique({
      where: { id: lienId },
      include: { receipt: { include: { warehouse: { select: { userId: true, name: true } } } } },
    });
    if (!lien) throw new NotFoundException('Application not found');
    if (lien.status !== LienStatus.PENDING) {
      throw new BadRequestException(`Only a pending application can be confirmed (this one is ${lien.status.toLowerCase()})`);
    }
    const ref = (dto.loanRefNo || '').trim();
    if (ref.length < 3) throw new BadRequestException("Enter the bank's loan reference number");

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.bankLien.updateMany({
        where: { id: lienId, status: LienStatus.PENDING },
        data: {
          status: LienStatus.ACTIVE,
          loanRefNo: ref,
          ...(dto.interestRate !== undefined && { interestRate: dto.interestRate }),
          decidedById: deciderId, decidedAt: new Date(), decisionNote: dto.note || null,
        },
      });
      if (res.count === 0) throw new BadRequestException('This application was just decided — refresh and check its status');

      // The loan is real now: book the disbursement.
      await tx.transaction.create({
        data: {
          userId: lien.receipt.ownerId,
          type: TransactionType.LOAN_DISBURSEMENT,
          amount: lien.loanAmount,
          description: `Loan confirmed by ${lien.bankName} (ref ${ref}) against receipt ${lien.receipt.receiptNumber}`,
          referenceId: lien.id,
          referenceType: 'lien',
        },
      });
    });

    await recordAudit(this.prisma, deciderId, 'lien_confirmed', 'lien', lienId, { loanRefNo: ref, amount: Number(lien.loanAmount) });
    await this.notifications.notifyMany([
      {
        userId: lien.receipt.ownerId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Loan confirmed — goods under bank lien',
        body: `${lien.bankName} loan of ₨${Number(lien.loanAmount).toLocaleString()} confirmed (ref ${ref}). Receipt ${lien.receipt.receiptNumber} is now under bank lien until the bank records clearance.`,
        data: { link: '/warehouse', receiptId: lien.receiptId },
      },
      {
        userId: lien.receipt.warehouse.userId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Bank lien is now active',
        body: `The ${lien.bankName} lien on receipt ${lien.receipt.receiptNumber} is confirmed (ref ${ref}). Do not release these goods until the bank's clearance is recorded.`,
        data: { link: '/warehouse-portal', receiptId: lien.receiptId },
      },
    ]);
    return { message: 'Lien confirmed and activated.' };
  }

  // ─── ADMIN / MODERATOR DECLINES A LIEN APPLICATION ────────────────────────
  async rejectLien(lienId: string, deciderId: string, note?: string) {
    const lien = await this.prisma.bankLien.findUnique({
      where: { id: lienId },
      include: { receipt: { include: { warehouse: { select: { userId: true } } } } },
    });
    if (!lien) throw new NotFoundException('Application not found');
    if (lien.status !== LienStatus.PENDING) {
      throw new BadRequestException(`Only a pending application can be declined (this one is ${lien.status.toLowerCase()})`);
    }
    const reason = (note || '').trim();
    if (reason.length < 5) throw new BadRequestException('Give the depositor a reason for declining (at least 5 characters)');

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.bankLien.updateMany({
        where: { id: lienId, status: LienStatus.PENDING },
        data: { status: LienStatus.REJECTED, decidedById: deciderId, decidedAt: new Date(), decisionNote: reason },
      });
      if (res.count === 0) throw new BadRequestException('This application was just decided — refresh and check its status');
      await tx.warehouseReceipt.updateMany({
        where: { id: lien.receiptId, status: ReceiptStatus.UNDER_LIEN },
        data: { status: ReceiptStatus.ACTIVE },
      });
    });

    await recordAudit(this.prisma, deciderId, 'lien_rejected', 'lien', lienId, { reason });
    await this.notifications.notifyMany([
      {
        userId: lien.receipt.ownerId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Loan application declined',
        body: `Your ${lien.bankName} application on receipt ${lien.receipt.receiptNumber} was declined: ${reason}. Your goods are no longer on hold.`,
        data: { link: '/warehouse', receiptId: lien.receiptId },
      },
      {
        userId: lien.receipt.warehouse.userId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Loan application declined',
        body: `The loan application on receipt ${lien.receipt.receiptNumber} was declined. The hold on these goods is lifted.`,
        data: { link: '/warehouse-portal', receiptId: lien.receiptId },
      },
    ]);
    return { message: 'Application declined. The goods are released from hold.' };
  }

  // ─── RECORD BANK CLEARANCE / RELEASE LIEN ─────────────────────────────────
  // Only the warehouse holding the goods (which receives the bank's release
  // letter) or an AgriConnect admin/moderator may record that the bank has
  // cleared the lien. The depositor deliberately cannot: they would be
  // clearing their own collateral, which defeats the point of the lien.
  async releaseLien(lienId: string, userId: string, userRole: string, note?: string) {
    const lien = await this.prisma.bankLien.findUnique({
      where: { id: lienId },
      include: { receipt: { include: { warehouse: { select: { userId: true, name: true } } } } },
    });
    if (!lien) throw new NotFoundException('Lien not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    const isOperator = lien.receipt.warehouse.userId === userId;
    if (!isAdmin && !isOperator) {
      throw new ForbiddenException('Only the warehouse or an AgriConnect admin can record the bank\'s clearance of a lien');
    }
    if (lien.status !== LienStatus.ACTIVE) throw new BadRequestException(`This lien is already ${lien.status.toLowerCase()}`);
    const reference = (note || '').trim();
    if (!reference) throw new BadRequestException('Enter the bank\'s clearance reference (release letter / reference number)');

    // Guarded on the status we validated, in one transaction: two simultaneous
    // clearances (double-click, two admins) can only succeed once, so the
    // repayment is booked exactly once.
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.bankLien.updateMany({
        where: { id: lienId, status: LienStatus.ACTIVE },
        data: { status: LienStatus.RELEASED, releasedAt: new Date(), releaseNote: reference },
      });
      if (res.count === 0) throw new BadRequestException('This lien was just cleared — refresh and check its status');
      await tx.warehouseReceipt.update({
        where: { id: lien.receiptId },
        data: { status: ReceiptStatus.ACTIVE },
      });
      // Clearance means the bank has been repaid: book the repayment.
      await tx.transaction.create({
        data: {
          userId: lien.receipt.ownerId,
          type: TransactionType.LOAN_REPAYMENT,
          amount: lien.loanAmount,
          description: `Loan cleared by ${lien.bankName} (ref ${reference}) on receipt ${lien.receipt.receiptNumber}`,
          referenceId: lien.id,
          referenceType: 'lien',
        },
      });
    });

    await this.notifications.notifyMany([
      {
        userId: lien.receipt.ownerId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Bank lien cleared',
        body: `${lien.bankName} has cleared the lien on receipt ${lien.receipt.receiptNumber} (ref: ${reference}). Your goods are free to be released.`,
        data: { link: '/warehouse', receiptId: lien.receiptId },
      },
      {
        userId: lien.receipt.warehouse.userId,
        type: NotificationType.LOAN_UPDATE,
        title: 'Bank lien cleared',
        body: `Clearance recorded for receipt ${lien.receipt.receiptNumber} (${lien.bankName}, ref: ${reference}). Gate-out can now be requested.`,
        data: { link: '/warehouse-portal', receiptId: lien.receiptId },
      },
    ]);

    return { message: 'Bank clearance recorded. The lien is released and gate-out is unblocked.' };
  }

  // ─── BUY INSURANCE ────────────────────────────────────────────────────────
  // The premium is the warehouse's own rate (per ton per month) × the stored
  // quantity × the months left on the receipt; cover is the receipt's value.
  // Nothing about price, insurer or cover comes from the client any more
  // (it used to accept a made-up insurer and any premium the browser sent).
  async quoteInsurance(receipt: { quantityTons: number; marketValue: any; expiryDate: Date; commodity: string; warehouse: { name: string; insuranceAvailable: boolean; insurancePricePerTonMonth: any } }) {
    const rate = Number(receipt.warehouse.insurancePricePerTonMonth || 0);
    if (!receipt.warehouse.insuranceAvailable || !(rate > 0)) {
      throw new BadRequestException('This warehouse has not priced storage insurance yet, so cover cannot be bought for this receipt.');
    }
    const coverageAmount = Number(receipt.marketValue);
    if (!(coverageAmount > 0)) {
      throw new BadRequestException('The value of these goods has not been set yet (valuation pending), so cover cannot be quoted. Please try again later.');
    }
    const msLeft = receipt.expiryDate.getTime() - Date.now();
    const months = Math.max(1, Math.ceil(msLeft / (30 * 24 * 60 * 60 * 1000)));
    const premiumAmount = Math.round(rate * receipt.quantityTons * months * 100) / 100;
    return { rate, months, coverageAmount, premiumAmount, provider: receipt.warehouse.name };
  }

  async getInsuranceQuote(ownerId: string, receiptId: string) {
    const receipt = await this.prisma.warehouseReceipt.findUnique({
      where: { id: receiptId },
      include: { insurance: true, warehouse: { select: { name: true, insuranceAvailable: true, insurancePricePerTonMonth: true } } },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.ownerId !== ownerId) throw new ForbiddenException('Not your receipt');
    if (receipt.insurance) throw new BadRequestException('Insurance already active on this receipt');
    return this.quoteInsurance(receipt as any);
  }

  async buyInsurance(ownerId: string, dto: BuyInsuranceDto) {
    const receipt = await this.prisma.warehouseReceipt.findUnique({
      where: { id: dto.receiptId },
      include: { insurance: true, warehouse: { select: { name: true, insuranceAvailable: true, insurancePricePerTonMonth: true } } },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.ownerId !== ownerId) throw new ForbiddenException('Not your receipt');
    if (receipt.insurance) throw new BadRequestException('Insurance already active on this receipt');
    const quote = await this.quoteInsurance(receipt as any);

    // Policy numbers come from a native sequence (policySeq) instead of a
    // 4-digit Math.random(), which could collide.
    const prefix = quote.provider.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'POL';
    let insurance;
    try {
      insurance = await this.prisma.$transaction(async (tx) => {
        const holder = await tx.storageInsurance.create({
          data: {
            receiptId: dto.receiptId,
            provider: quote.provider,
            planName: 'Storage cover',
            policyNumber: `TMP-${uuidv4()}`,
            coverageAmount: quote.coverageAmount,
            premiumAmount: quote.premiumAmount,
            coverage: "As per the warehouse's storage insurance terms",
            startDate: new Date(),
            endDate: receipt.expiryDate,
            status: 'active',
          },
        });
        return tx.storageInsurance.update({
          where: { id: holder.id },
          data: { policyNumber: `${prefix}-AGR-${new Date().getFullYear()}-${String(holder.policySeq).padStart(6, '0')}` },
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException('Insurance already active on this receipt');
      throw e;
    }

    return {
      insurance,
      message: `Insurance policy activated. Policy No: ${insurance.policyNumber}`,
    };
  }

  // ─── WAREHOUSE DASHBOARD (operator) ──────────────────────────────────────
  // NEW_Changes item 10: an operator account is no longer capped at one
  // warehouse (see create() below), so this now also returns the full list
  // of the operator's warehouses (lightweight, for a picker) alongside the
  // full stats/bookings detail for whichever one is selected.
  async getMyWarehouses(operatorId: string) {
    const warehouses = await this.prisma.warehouseProfile.findMany({
      where: { userId: operatorId },
      orderBy: { createdAt: 'asc' },
    });
    if (!warehouses.length) return [];

    const usage = await this.prisma.storageBooking.groupBy({
      by: ['warehouseId'],
      where: { warehouseId: { in: warehouses.map((w) => w.id) }, status: { in: CAPACITY_HELD_STATUSES } },
      _sum: { quantityTons: true },
    });
    const usedByWarehouse = new Map<string, number>(
      usage.map((u) => [u.warehouseId as string, (u._sum.quantityTons as number) || 0]),
    );
    return warehouses.map((w) => ({
      ...w,
      availableCapacityTons: w.totalCapacityTons - (usedByWarehouse.get(w.id) || 0),
    }));
  }

  async getWarehouseDashboard(operatorId: string, warehouseId?: string) {
    const warehouse = warehouseId
      ? await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } })
      : await this.prisma.warehouseProfile.findFirst({ where: { userId: operatorId }, orderBy: { createdAt: 'asc' } });
    if (!warehouse) throw new NotFoundException('No warehouse profile found');
    if (warehouse.userId !== operatorId) throw new ForbiddenException('Not your warehouse');

    const [bookings, receipts, activeReceipts, myWarehouses] = await Promise.all([
      this.prisma.storageBooking.findMany({
        where: { warehouseId: warehouse.id },
        include: {
          // Full requester details so the operator can review a booking
          // properly instead of seeing just a name and city.
          depositor: { select: { id: true, phoneNumber: true, email: true, kycStatus: true, profile: { select: { fullName: true, businessName: true, city: true, province: true } } } },
          _count: { select: { messages: true } },
          receipt: { select: { id: true, receiptNumber: true, status: true, lien: { select: { id: true, bankName: true, loanAmount: true, status: true, placedAt: true } } } },
          // Document state per booking (NEW_Changes item 10) so the
          // dashboard can show invoice/GRN/gate-pass status inline
          // without extra round trips.
          invoice: { select: { id: true, invoiceNumber: true, status: true, totalAmount: true } },
          goodsReceiptNote: { select: { id: true, grnNumber: true } },
          gateOutPasses: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.warehouseReceipt.count({ where: { warehouseId: warehouse.id } }),
      this.prisma.warehouseReceipt.count({
        where: { warehouseId: warehouse.id, status: ReceiptStatus.ACTIVE },
      }),
      this.getMyWarehouses(operatorId),
    ]);

    const totalBookings = await this.prisma.storageBooking.count({ where: { warehouseId: warehouse.id } });

    const usedCapacity = await this.prisma.storageBooking.aggregate({
      where: { warehouseId: warehouse.id, status: { in: CAPACITY_HELD_STATUSES } },
      _sum: { quantityTons: true },
    });

    const revenue = await this.prisma.storageBooking.aggregate({
      where: { warehouseId: warehouse.id, status: { in: [BookingStatus.ACTIVE, BookingStatus.COMPLETED] } },
      _sum: { totalCost: true },
    });

    return {
      warehouses: myWarehouses,
      warehouse: {
        ...warehouse,
        availableCapacityTons: warehouse.totalCapacityTons - (usedCapacity._sum.quantityTons || 0),
      },
      stats: {
        totalBookings,
        totalReceipts: receipts,
        activeReceipts,
        totalRevenue: revenue._sum.totalCost || 0,
        usedCapacityTons: usedCapacity._sum.quantityTons || 0,
        availableCapacityTons: warehouse.totalCapacityTons - (usedCapacity._sum.quantityTons || 0),
      },
      recentBookings: withBookingReferences(bookings),
    };
  }

  // ─── ADMIN: ALL WAREHOUSES ────────────────────────────────────────────────
  async adminGetAll() {
    return this.prisma.warehouseProfile.findMany({
      include: {
        user: { select: { profile: { select: { fullName: true } }, kycStatus: true } },
        _count: { select: { bookings: true, receipts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Admin: mark a warehouse as verified/unverified — a trust signal shown
  // to buyers, separate from isActive (listed/delisted).
  async adminVerify(warehouseId: string, verified: boolean, actorId?: string) {
    // Guard added Round 2, Milestone 6 for consistency with
    // adminSetActive just below (and with the equivalent TestingService/
    // TransportService methods this pattern was just copied to) — a
    // missing warehouse previously fell straight through to Prisma's raw
    // "record to update not found" error instead of a clean 404.
    const warehouse = await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const res = await this.prisma.warehouseProfile.update({
      where: { id: warehouseId },
      data: { isVerified: verified },
    });
    await recordAudit(this.prisma, actorId, verified ? 'warehouse_verified' : 'warehouse_unverified', 'warehouse', warehouseId);
    return res;
  }

  // "Delist" a warehouse — hides it from public browsing without touching
  // the underlying user account (an admin might want to hide a listing
  // while still letting the operator log in to fix something).
  async adminSetActive(warehouseId: string, isActive: boolean, actorId?: string) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const res = await this.prisma.warehouseProfile.update({ where: { id: warehouseId }, data: { isActive } });
    await recordAudit(this.prisma, actorId, isActive ? 'warehouse_relisted' : 'warehouse_delisted', 'warehouse', warehouseId);
    return res;
  }
}
