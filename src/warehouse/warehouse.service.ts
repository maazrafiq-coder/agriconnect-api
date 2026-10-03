import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { ReceiptStatus, LienStatus, TransactionType, BookingStatus } from '@prisma/client';
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

export class BuyInsuranceDto {
  @IsString() receiptId: string;
  @IsString() provider: string;
  @IsString() planName: string;
  @IsNumber() @Min(0) coverageAmount: number;
  @IsNumber() @Min(0) premiumAmount: number;
  @IsString() coverage: string;
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
  constructor(private prisma: PrismaService, private storage: StorageService) {}

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

    // Check available capacity
    const activeBookings = await this.prisma.storageBooking.aggregate({
      where: { warehouseId: dto.warehouseId, status: { in: CAPACITY_HELD_STATUSES } },
      _sum: { quantityTons: true },
    });
    const usedTons = activeBookings._sum.quantityTons || 0;
    const available = warehouse.totalCapacityTons - usedTons;
    if (dto.quantityTons > available) {
      throw new BadRequestException(`Only ${available} tons available. Requested ${dto.quantityTons} tons.`);
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

    const booking = await this.prisma.storageBooking.create({
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

    await this.prisma.transaction.create({
      data: {
        userId: depositorId,
        type: TransactionType.STORAGE_FEE,
        amount: totalCost,
        description: `Storage booking request at ${booking.warehouse.name} (${dto.quantityTons} tons, ${dto.durationDays} days)`,
        referenceId: booking.id,
        referenceType: 'storage',
      },
    });

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
        receipt: { select: { id: true, receiptNumber: true, status: true } },
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
        receipt: true,
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

    const updated = await this.prisma.storageBooking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.REJECTED, rejectedAt: new Date(), rejectionReason: dto.reason },
      include: { warehouse: { select: { name: true, city: true } } },
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

    const updated = await this.prisma.storageBooking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED, cancelledAt: new Date(), cancelReason: dto.reason },
      include: { warehouse: { select: { name: true, city: true } } },
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
    if (booking.receipt?.lien && booking.receipt.lien.status === LienStatus.ACTIVE) {
      throw new BadRequestException('This receipt still has an active bank lien — it must be released before the booking can be completed');
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

    const receiptNumber = `WR-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000 + 1000)).padStart(4, '0')}`;

    // Estimate market value (simplified — in production use live price feed)
    const pricePerTon = 38000; // example PKR/ton for rice
    const marketValue = actualQuantityTons * pricePerTon;

    const receipt = await this.prisma.warehouseReceipt.create({
      data: {
        receiptNumber,
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
      include: {
        warehouse: { select: { name: true, city: true } },
        owner: { select: { profile: { select: { fullName: true } } } },
      },
    });

    // Goods have physically arrived and been weighed/quality-checked —
    // booking moves from ACCEPTED to ACTIVE.
    await this.prisma.storageBooking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.ACTIVE },
    });

    // NEW_Changes item 10: a formal Goods Receipt Note, issued at exactly
    // this moment — this IS "when the goods are received" in the system,
    // so there's no separate manual step for it. Distinct from the
    // WarehouseReceipt above (that's a collateral/ownership document used
    // for bank liens and insurance; this is the delivery acknowledgment).
    await this.issueGoodsReceiptNote(booking, operatorId, actualQuantityTons, qualityMetrics);

    return receipt;
  }

  private async issueGoodsReceiptNote(
    booking: { id: string; warehouseId: string; depositorId: string; commodity: string; variety: string | null },
    operatorId: string,
    quantityTons: number,
    qualityMetrics: any,
  ) {
    const [warehouse, depositor] = await Promise.all([
      this.prisma.warehouseProfile.findUnique({ where: { id: booking.warehouseId } }),
      this.prisma.user.findUnique({ where: { id: booking.depositorId }, select: { profile: { select: { fullName: true } } } }),
    ]);

    const qualityNotes = qualityMetrics == null ? null
      : typeof qualityMetrics === 'string' ? qualityMetrics
      : JSON.stringify(qualityMetrics);

    // Reserve the seq first (a throwaway create+read would work too, but
    // this way the PDF can embed the real grnNumber from the start).
    const seqHolder = await this.prisma.goodsReceiptNote.create({
      data: {
        grnNumber: 'PENDING',
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

    return this.prisma.goodsReceiptNote.update({
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

    const [depositor] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: booking.depositorId }, select: { profile: { select: { fullName: true, address: true, city: true } } } }),
    ]);

    const storageCost = Number(booking.totalCost) - Number(booking.insuranceCost || 0);

    const seqHolder = await this.prisma.warehouseInvoice.create({
      data: {
        invoiceNumber: 'PENDING',
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
    const invoice = await this.prisma.warehouseInvoice.findUnique({ where: { id: invoiceId }, include: { warehouse: true } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    if (invoice.warehouse.userId !== userId && !isAdmin) throw new ForbiddenException('Not authorized to confirm this payment');
    if (invoice.status === 'PAID') throw new BadRequestException('This invoice is already marked as paid');

    return this.prisma.warehouseInvoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID', paidAt: new Date(), paymentReference, confirmedById: userId },
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
      select: { id: true, depositorId: true, status: true, warehouse: { select: { userId: true } } },
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
    return this.prisma.bookingMessage.create({
      data: { bookingId, senderId: userId, kind: kind as any, body },
    });
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
    const existingPending = await this.prisma.gateOutPass.findFirst({ where: { bookingId, status: 'PENDING' } });
    if (existingPending) throw new BadRequestException('There is already a pending gate-out request for this booking');

    return this.prisma.gateOutPass.create({
      data: {
        bookingId,
        warehouseId: booking.warehouseId,
        depositorId: booking.depositorId,
        quantityTons: quantityTons ?? booking.quantityTons,
        requestedById: operatorId,
        requestNote,
      },
    });
  }

  async approveGateOut(userId: string, userRole: string, passId: string) {
    const pass = await this.prisma.gateOutPass.findUnique({ where: { id: passId }, include: { warehouse: true, booking: true } });
    if (!pass) throw new NotFoundException('Gate-out request not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    const isDepositor = pass.depositorId === userId;
    if (!isAdmin && !isDepositor) throw new ForbiddenException('Only the depositor or an admin can approve a gate-out request');
    if (pass.status !== 'PENDING') throw new BadRequestException(`This request has already been ${pass.status.toLowerCase()}`);

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

    return this.prisma.gateOutPass.update({
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
  }

  async rejectGateOut(userId: string, userRole: string, passId: string, rejectionNote?: string) {
    const pass = await this.prisma.gateOutPass.findUnique({ where: { id: passId } });
    if (!pass) throw new NotFoundException('Gate-out request not found');
    const isAdmin = userRole === 'ADMIN' || userRole === 'MODERATOR';
    const isDepositor = pass.depositorId === userId;
    if (!isAdmin && !isDepositor) throw new ForbiddenException('Only the depositor or an admin can reject a gate-out request');
    if (pass.status !== 'PENDING') throw new BadRequestException(`This request has already been ${pass.status.toLowerCase()}`);

    return this.prisma.gateOutPass.update({
      where: { id: passId },
      data: { status: 'REJECTED', approvedById: userId, approverRole: isAdmin ? 'ADMIN' : 'DEPOSITOR', approvedAt: new Date(), rejectionNote },
    });
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
      include: { lien: true },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.ownerId !== ownerId) throw new ForbiddenException('Not your receipt');
    if (receipt.status !== ReceiptStatus.ACTIVE) throw new BadRequestException('Receipt must be Active to apply for a lien');
    if (receipt.lien) throw new BadRequestException('A lien is already placed on this receipt');

    const maxLoan = Number(receipt.marketValue) * 0.70;
    if (dto.loanAmount > maxLoan) {
      throw new BadRequestException(`Maximum eligible loan is ₨${maxLoan.toLocaleString()} (70% of commodity value)`);
    }

    // Idempotency guard: atomically flip the receipt to UNDER_LIEN only if
    // it is still ACTIVE. If two requests race (double-tap, retry), the
    // second one's updateMany affects 0 rows and fails cleanly instead of
    // creating two BankLien rows against the same collateral.
    const guarded = await this.prisma.warehouseReceipt.updateMany({
      where: { id: dto.receiptId, status: ReceiptStatus.ACTIVE },
      data: { status: ReceiptStatus.UNDER_LIEN },
    });
    if (guarded.count === 0) {
      throw new BadRequestException('This receipt is no longer available for a new lien application');
    }

    let lien;
    try {
      lien = await this.prisma.bankLien.create({
        data: {
          receiptId: dto.receiptId,
          bankName: dto.bankName,
          loanPurpose: dto.loanPurpose,
          loanAmount: dto.loanAmount,
          interestRate: dto.interestRate,
          tenureMonths: dto.tenureMonths,
          loanOfficer: dto.loanOfficer,
          status: LienStatus.ACTIVE,
        },
      });
    } catch (err) {
      // Roll back the receipt status flip if lien creation somehow fails
      // (e.g. unique constraint conflict) so the receipt isn't stuck
      // permanently locked with no lien attached.
      await this.prisma.warehouseReceipt.update({
        where: { id: dto.receiptId },
        data: { status: ReceiptStatus.ACTIVE },
      });
      throw err;
    }

    await this.prisma.transaction.create({
      data: {
        userId: ownerId,
        type: TransactionType.LOAN_DISBURSEMENT,
        amount: dto.loanAmount,
        description: `Loan application submitted to ${dto.bankName} against receipt ${receipt.receiptNumber}`,
        referenceId: lien.id,
        referenceType: 'lien',
      },
    });

    return {
      lien,
      message: 'Loan application submitted successfully.',
      nextSteps: [
        `${dto.bankName} will contact you within 2–5 working days`,
        'A bank officer will verify the warehouse receipt',
        'Loan will be disbursed to your registered bank account',
        'Lien will be released upon full loan repayment',
      ],
    };
  }

  // ─── RELEASE LIEN ─────────────────────────────────────────────────────────
  async releaseLien(lienId: string, userId: string, note?: string) {
    const lien = await this.prisma.bankLien.findUnique({
      where: { id: lienId },
      include: { receipt: true },
    });
    if (!lien) throw new NotFoundException('Lien not found');
    if (lien.receipt.ownerId !== userId) throw new ForbiddenException('Not your lien');

    await this.prisma.$transaction([
      this.prisma.bankLien.update({
        where: { id: lienId },
        data: { status: LienStatus.RELEASED, releasedAt: new Date(), releaseNote: note },
      }),
      this.prisma.warehouseReceipt.update({
        where: { id: lien.receiptId },
        data: { status: ReceiptStatus.ACTIVE },
      }),
    ]);

    return { message: 'Lien released. Receipt is now fully in your control.' };
  }

  // ─── BUY INSURANCE ────────────────────────────────────────────────────────
  async buyInsurance(ownerId: string, dto: BuyInsuranceDto) {
    const receipt = await this.prisma.warehouseReceipt.findUnique({
      where: { id: dto.receiptId },
      include: { insurance: true },
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    if (receipt.ownerId !== ownerId) throw new ForbiddenException('Not your receipt');
    if (receipt.insurance) throw new BadRequestException('Insurance already active on this receipt');

    const policyNumber = `${dto.provider.slice(0, 3).toUpperCase()}-AGR-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`;

    const insurance = await this.prisma.storageInsurance.create({
      data: {
        receiptId: dto.receiptId,
        provider: dto.provider,
        planName: dto.planName,
        policyNumber,
        coverageAmount: dto.coverageAmount,
        premiumAmount: dto.premiumAmount,
        coverage: dto.coverage,
        startDate: new Date(),
        endDate: receipt.expiryDate,
        status: 'active',
      },
    });

    return {
      insurance,
      message: `Insurance policy activated. Policy No: ${policyNumber}`,
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
  async adminVerify(warehouseId: string, verified: boolean) {
    // Guard added Round 2, Milestone 6 for consistency with
    // adminSetActive just below (and with the equivalent TestingService/
    // TransportService methods this pattern was just copied to) — a
    // missing warehouse previously fell straight through to Prisma's raw
    // "record to update not found" error instead of a clean 404.
    const warehouse = await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return this.prisma.warehouseProfile.update({
      where: { id: warehouseId },
      data: { isVerified: verified },
    });
  }

  // "Delist" a warehouse — hides it from public browsing without touching
  // the underlying user account (an admin might want to hide a listing
  // while still letting the operator log in to fix something).
  async adminSetActive(warehouseId: string, isActive: boolean) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return this.prisma.warehouseProfile.update({ where: { id: warehouseId }, data: { isActive } });
  }
}
