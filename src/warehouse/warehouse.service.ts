import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptStatus, LienStatus, TransactionType } from '@prisma/client';
import {
  IsString, IsNumber, IsOptional, IsBoolean, IsDateString, IsArray, Min,
} from 'class-validator';
import { v4 as uuidv4 } from 'uuid';

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
  @IsNumber() @Min(1) minDurationDays: number;
  @IsArray() @IsString({ each: true }) commoditiesAccepted: string[];
  @IsOptional() @IsArray() certifications?: string[];
  @IsOptional() @IsArray() features?: string[];
  @IsOptional() @IsArray() bankPartners?: string[];
  @IsOptional() @IsBoolean() insuranceAvailable?: boolean;
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

// ─── SERVICE ─────────────────────────────────────────────────────────────────
@Injectable()
export class WarehouseService {
  constructor(private prisma: PrismaService) {}

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
        status: { in: ['confirmed', 'active'] },
      },
      _sum: { quantityTons: true },
    });
    const usedByWarehouse = new Map(usage.map((u) => [u.warehouseId, u._sum.quantityTons || 0]));

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
      where: { warehouseId: id, status: { in: ['confirmed', 'active'] } },
      _sum: { quantityTons: true },
    });
    const usedTons = activeBookings._sum.quantityTons || 0;

    return { ...warehouse, availableCapacityTons: warehouse.totalCapacityTons - usedTons };
  }

  // ─── REGISTER WAREHOUSE ───────────────────────────────────────────────────
  async create(userId: string, dto: CreateWarehouseDto) {
    const existing = await this.prisma.warehouseProfile.findUnique({ where: { userId } });
    if (existing) throw new BadRequestException('You already have a warehouse profile');

    return this.prisma.warehouseProfile.create({
      data: { userId, ...dto } as any,
    });
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
      where: { warehouseId: dto.warehouseId, status: { in: ['confirmed', 'active'] } },
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
    const totalCost = dto.quantityTons * Number(warehouse.pricePerTonMonth) * monthsDecimal;

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
        pricePerTon: warehouse.pricePerTonMonth,
        totalCost,
        includeInsurance: dto.includeInsurance || false,
        notes: dto.notes,
        status: 'confirmed',
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
        description: `Storage booking at ${booking.warehouse.name} (${dto.quantityTons} tons, ${dto.durationDays} days)`,
        referenceId: booking.id,
        referenceType: 'storage',
      },
    });

    return {
      booking,
      message: 'Storage booked successfully. A Digital Warehouse Receipt will be issued upon commodity arrival and weighing.',
      nextSteps: [
        'Deliver your commodity to the warehouse by the entry date',
        'Warehouse staff will weigh and quality-check on arrival',
        'Digital Warehouse Receipt (DWR) will be issued within 24 hours',
        'You can then use the DWR to apply for bank financing',
      ],
    };
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

    // Update booking status
    await this.prisma.storageBooking.update({
      where: { id: bookingId },
      data: { status: 'active' },
    });

    return receipt;
  }

  // ─── MY RECEIPTS ──────────────────────────────────────────────────────────
  async getMyReceipts(ownerId: string) {
    return this.prisma.warehouseReceipt.findMany({
      where: { ownerId },
      include: {
        warehouse: { select: { name: true, city: true, province: true, managerPhone: true } },
        lien: true,
        insurance: true,
        booking: { select: { totalCost: true, includeInsurance: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
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
    return receipt;
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
  async getWarehouseDashboard(operatorId: string) {
    const warehouse = await this.prisma.warehouseProfile.findUnique({
      where: { userId: operatorId },
    });
    if (!warehouse) throw new NotFoundException('No warehouse profile found');

    const [bookings, receipts, activeReceipts] = await Promise.all([
      this.prisma.storageBooking.findMany({
        where: { warehouseId: warehouse.id },
        include: {
          depositor: { select: { profile: { select: { fullName: true, city: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.warehouseReceipt.count({ where: { warehouseId: warehouse.id } }),
      this.prisma.warehouseReceipt.count({
        where: { warehouseId: warehouse.id, status: ReceiptStatus.ACTIVE },
      }),
    ]);

    const usedCapacity = await this.prisma.storageBooking.aggregate({
      where: { warehouseId: warehouse.id, status: { in: ['confirmed', 'active'] } },
      _sum: { quantityTons: true },
    });

    const revenue = await this.prisma.storageBooking.aggregate({
      where: { warehouseId: warehouse.id, status: { in: ['active', 'completed'] } },
      _sum: { totalCost: true },
    });

    return {
      warehouse: {
        ...warehouse,
        availableCapacityTons: warehouse.totalCapacityTons - (usedCapacity._sum.quantityTons || 0),
      },
      stats: {
        totalBookings: bookings.length,
        totalReceipts: receipts,
        activeReceipts,
        totalRevenue: revenue._sum.totalCost || 0,
        usedCapacityTons: usedCapacity._sum.quantityTons || 0,
        availableCapacityTons: warehouse.totalCapacityTons - (usedCapacity._sum.quantityTons || 0),
      },
      recentBookings: bookings,
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

  async adminVerify(warehouseId: string, verified: boolean) {
    return this.prisma.warehouseProfile.update({
      where: { id: warehouseId },
      data: { isVerified: verified },
    });
  }
}
