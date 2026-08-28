// ─── TESTING SERVICE ──────────────────────────────────────────────────────────
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TestingStatus, PaymentStatus } from '@prisma/client';
import { IsString, IsNumber, IsOptional, IsArray, IsDateString, IsBoolean, Min } from 'class-validator';

export class CreateTestingRequestDto {
  @IsString() agencyId: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsArray() @IsString({ each: true }) servicesRequested: string[];
  @IsOptional() @IsDateString() scheduledDate?: string;
  @IsOptional() @IsString() sampleLocation?: string;
  @IsOptional() @IsString() notes?: string;
}

export class SubmitReportDto {
  @IsString() reportUrl: string;
  reportData: any;
}

export class AgencyQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() service?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsNumber() @Min(1) page?: number = 1;
  @IsOptional() @IsNumber() @Min(1) limit?: number = 20;
}

export class RegisterAgencyDto {
  @IsString() name: string;
  @IsString() city: string;
  @IsString() province: string;
  @IsArray() @IsString({ each: true }) services: string[];
  @IsNumber() @Min(0) basePrice: number;
  @IsNumber() @Min(1) turnaroundHours: number;
  @IsOptional() @IsArray() @IsString({ each: true }) accreditations?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) coverageAreas?: string[];
}

export class UpdateAgencyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  @IsOptional() @IsNumber() @Min(0) basePrice?: number;
  @IsOptional() @IsNumber() @Min(1) turnaroundHours?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) accreditations?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) coverageAreas?: string[];
}

// ─── TESTING REQUEST STATUS STATE MACHINE (Round 2, Milestone 7) ──────────────
// Previously PATCH /testing/requests/:id/status accepted *any* TestingStatus
// from *either* the requester or the agency, with zero transition rules.
// That meant a requester (buyer) could mark their own quality test
// COMPLETED directly — completely bypassing submitReport, the endpoint
// that's supposed to be the only legitimate way to complete a request
// (agency-only, and requires an actual report). COMPLETED is deliberately
// excluded from every transition below; it's rejected explicitly in
// updateStatus() with a message pointing at submitReport instead.
type TestingParty = 'requester' | 'agency';
const TESTING_TRANSITIONS: Record<TestingStatus, { to: TestingStatus; allowedParties: TestingParty[] }[]> = {
  [TestingStatus.REQUESTED]: [
    { to: TestingStatus.ASSIGNED, allowedParties: ['agency'] },
    { to: TestingStatus.CANCELLED, allowedParties: ['requester', 'agency'] },
  ],
  [TestingStatus.ASSIGNED]: [
    { to: TestingStatus.SAMPLE_COLLECTED, allowedParties: ['agency'] },
    { to: TestingStatus.CANCELLED, allowedParties: ['requester', 'agency'] },
  ],
  [TestingStatus.SAMPLE_COLLECTED]: [
    { to: TestingStatus.IN_PROGRESS, allowedParties: ['agency'] },
    { to: TestingStatus.CANCELLED, allowedParties: ['agency'] },
  ],
  [TestingStatus.IN_PROGRESS]: [
    { to: TestingStatus.CANCELLED, allowedParties: ['agency'] },
  ],
  [TestingStatus.COMPLETED]: [],
  [TestingStatus.CANCELLED]: [],
};

@Injectable()
export class TestingService {
  constructor(private prisma: PrismaService) {}

  // Admin: delist a testing agency without touching the underlying account
  async adminSetActive(agencyId: string, isActive: boolean) {
    const agency = await this.prisma.testingAgencyProfile.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Testing agency not found');
    return this.prisma.testingAgencyProfile.update({ where: { id: agencyId }, data: { isActive } });
  }

  // Admin: mark a testing agency as verified/unverified — a trust signal
  // shown to buyers, separate from isActive (listed/delisted). Round 2,
  // Milestone 6: this mirrors WarehouseService.adminVerify, which
  // existed for warehouses but had no equivalent here or on
  // TransportService, despite TestingAgencyProfile/TransportProfile
  // both already having an `isVerified` column (used in this file's own
  // findAllAgencies sort order below) with no way to ever set it true.
  async adminVerify(agencyId: string, verified: boolean) {
    const agency = await this.prisma.testingAgencyProfile.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Testing agency not found');
    return this.prisma.testingAgencyProfile.update({ where: { id: agencyId }, data: { isVerified: verified } });
  }

  // Admin: see ALL agencies including delisted ones (the public findAllAgencies
  // below only ever returns isActive:true, so admins need their own view to
  // find and relist a previously-delisted agency).
  async adminFindAll() {
    return this.prisma.testingAgencyProfile.findMany({
      include: { user: { select: { profile: { select: { fullName: true } } } } },
      orderBy: { name: 'asc' },
    });
  }

  async findAllAgencies(query: AgencyQueryDto) {
    const where: any = { isActive: true };
    if (query.search) where.name = { contains: query.search, mode: 'insensitive' };
    if (query.province) where.province = { contains: query.province, mode: 'insensitive' };
    if (query.city) where.city = { contains: query.city, mode: 'insensitive' };
    if (query.service) where.services = { has: query.service };

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);

    const [data, total] = await Promise.all([
      this.prisma.testingAgencyProfile.findMany({
        where,
        include: { _count: { select: { requests: true } } },
        orderBy: [{ isVerified: 'desc' }, { rating: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.testingAgencyProfile.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createRequest(requesterId: string, dto: CreateTestingRequestDto) {
    const agency = await this.prisma.testingAgencyProfile.findUnique({
      where: { userId: dto.agencyId },
    });
    if (!agency) throw new NotFoundException('Testing agency not found');

    if (!dto.servicesRequested || dto.servicesRequested.length === 0) {
      throw new BadRequestException('Select at least one service to test');
    }

    // Validate every requested service is actually offered by this agency
    const invalid = dto.servicesRequested.filter((s) => !agency.services.includes(s));
    if (invalid.length > 0) {
      throw new BadRequestException(`This agency does not offer: ${invalid.join(', ')}`);
    }

    // Fee scales with number of services requested rather than always
    // charging the flat basePrice regardless of scope. First service is
    // charged at basePrice; each additional service adds 35% of basePrice
    // (reflects marginal lab cost, not full panel cost, per extra test).
    const basePrice = Number(agency.basePrice);
    const additionalServices = dto.servicesRequested.length - 1;
    const fee = basePrice + additionalServices * basePrice * 0.35;

    return this.prisma.testingRequest.create({
      data: {
        requesterId,
        agencyId: dto.agencyId,
        productId: dto.productId,
        orderId: dto.orderId,
        servicesRequested: dto.servicesRequested,
        scheduledDate: dto.scheduledDate ? new Date(dto.scheduledDate) : null,
        fee: Math.round(fee),
        sampleLocation: dto.sampleLocation,
        notes: dto.notes,
        status: TestingStatus.REQUESTED,
      },
      include: {
        agency: { include: { user: { select: { profile: { select: { fullName: true } } } } } },
      },
    });
  }

  // ─── OPERATOR SELF-SERVICE ──────────────────────────────────────────────
  // Mirrors the pattern warehouse operators already have (register once,
  // manage from a dashboard) — testing agencies never had a self-registration
  // path before, so there was no way to reach the "my agency" data below.
  async registerAgency(userId: string, dto: RegisterAgencyDto) {
    const existing = await this.prisma.testingAgencyProfile.findUnique({ where: { userId } });
    if (existing) throw new BadRequestException('You already have a testing agency profile');

    return this.prisma.testingAgencyProfile.create({
      data: { userId, ...dto } as any,
    });
  }

  async getMyAgency(userId: string) {
    const agency = await this.prisma.testingAgencyProfile.findUnique({ where: { userId } });
    if (!agency) throw new NotFoundException('No testing agency profile found');

    const [requests, pending, completed] = await Promise.all([
      this.prisma.testingRequest.findMany({
        where: { agencyId: userId },
        include: { requester: { select: { profile: { select: { fullName: true, city: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.testingRequest.count({ where: { agencyId: userId, status: { in: ['REQUESTED', 'ASSIGNED', 'SAMPLE_COLLECTED', 'IN_PROGRESS'] as any } } }),
      this.prisma.testingRequest.count({ where: { agencyId: userId, status: 'COMPLETED' as any } }),
    ]);

    return {
      agency,
      stats: { totalRequests: requests.length, pendingRequests: pending, completedRequests: completed },
      recentRequests: requests,
    };
  }

  async updateMyAgency(userId: string, dto: UpdateAgencyDto) {
    const existing = await this.prisma.testingAgencyProfile.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('No testing agency profile found');
    return this.prisma.testingAgencyProfile.update({ where: { userId }, data: dto as any });
  }

  async getMyRequests(userId: string, role: 'requester' | 'agency') {
    const where = role === 'requester' ? { requesterId: userId } : { agencyId: userId };
    return this.prisma.testingRequest.findMany({
      where,
      include: {
        requester: { select: { profile: { select: { fullName: true, city: true } } } },
        agency: { select: { name: true, city: true, user: { select: { profile: { select: { fullName: true } } } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async submitReport(requestId: string, agencyId: string, dto: SubmitReportDto) {
    const request = await this.prisma.testingRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.agencyId !== agencyId) throw new ForbiddenException('Not your request');
    if (request.status === TestingStatus.CANCELLED) {
      throw new BadRequestException('Cannot submit a report for a cancelled request');
    }
    if (request.status === TestingStatus.COMPLETED) {
      throw new BadRequestException('A report has already been submitted for this request');
    }

    return this.prisma.testingRequest.update({
      where: { id: requestId },
      data: {
        reportUrl: dto.reportUrl,
        reportData: dto.reportData,
        status: TestingStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  }

  async updateStatus(requestId: string, userId: string, status: TestingStatus) {
    const request = await this.prisma.testingRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');

    const party: TestingParty | null =
      request.agencyId === userId ? 'agency' : request.requesterId === userId ? 'requester' : null;
    if (!party) throw new ForbiddenException('Access denied');

    if (status === TestingStatus.COMPLETED) {
      throw new BadRequestException(
        'A testing request can only be marked Completed by submitting a report (see POST /testing/requests/:id/report) — it cannot be set directly',
      );
    }

    const transition = TESTING_TRANSITIONS[request.status]?.find((t) => t.to === status);
    if (!transition) {
      throw new BadRequestException(`Testing request cannot move from ${request.status} to ${status}`);
    }
    if (!transition.allowedParties.includes(party)) {
      throw new ForbiddenException(
        `Only the ${transition.allowedParties.join(' or ')} can move this request from ${request.status} to ${status}`,
      );
    }

    return this.prisma.testingRequest.update({ where: { id: requestId }, data: { status } });
  }
}

// ─── TRANSPORT SERVICE ────────────────────────────────────────────────────────
export class CreateTransportRequestDto {
  @IsString() pickupLocation: string;
  @IsString() pickupCity: string;
  @IsString() deliveryLocation: string;
  @IsString() deliveryCity: string;
  @IsOptional() @IsString() cargoDescription?: string;
  @IsOptional() @IsNumber() @Min(0) cargoWeightTons?: number;
  @IsOptional() @IsString() vehicleType?: string;
  @IsOptional() @IsDateString() requiredDate?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsString() notes?: string;
}

export class BookTransportDto {
  @IsString() requestId: string;
  @IsString() providerId: string;
  @IsNumber() @Min(0) agreedPrice: number;
}

export class TransportQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() pickupProvince?: string;
  @IsOptional() @IsString() deliveryProvince?: string;
  @IsOptional() @IsString() vehicleType?: string;
  @IsOptional() @IsNumber() @Min(1) page?: number = 1;
  @IsOptional() @IsNumber() @Min(1) limit?: number = 20;
}

export class RegisterProviderDto {
  @IsString() companyName: string;
  @IsArray() @IsString({ each: true }) vehicleTypes: string[];
  @IsNumber() @Min(0.1) maxCapacityTons: number;
  @IsArray() @IsString({ each: true }) coverageProvinces: string[];
  @IsNumber() @Min(0) pricePerKm: number;
  @IsOptional() @IsBoolean() hasGps?: boolean;
  @IsOptional() @IsBoolean() hasInsurance?: boolean;
  @IsOptional() @IsString() licenseNumber?: string;
}

export class UpdateProviderDto {
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) vehicleTypes?: string[];
  @IsOptional() @IsNumber() @Min(0.1) maxCapacityTons?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) coverageProvinces?: string[];
  @IsOptional() @IsNumber() @Min(0) pricePerKm?: number;
  @IsOptional() @IsBoolean() hasGps?: boolean;
  @IsOptional() @IsBoolean() hasInsurance?: boolean;
  @IsOptional() @IsString() licenseNumber?: string;
}

@Injectable()
export class TransportService {
  constructor(private prisma: PrismaService) {}

  // Admin: delist a transport provider without touching the underlying account
  async adminSetActive(providerId: string, isActive: boolean) {
    const provider = await this.prisma.transportProfile.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException('Transport provider not found');
    return this.prisma.transportProfile.update({ where: { id: providerId }, data: { isActive } });
  }

  // Admin: mark a transport provider as verified/unverified — see
  // TestingService.adminVerify above for the full reasoning. Round 2,
  // Milestone 6.
  async adminVerify(providerId: string, verified: boolean) {
    const provider = await this.prisma.transportProfile.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException('Transport provider not found');
    return this.prisma.transportProfile.update({ where: { id: providerId }, data: { isVerified: verified } });
  }

  async adminFindAll() {
    return this.prisma.transportProfile.findMany({
      include: { user: { select: { profile: { select: { fullName: true } } } } },
      orderBy: { companyName: 'asc' },
    });
  }

  async findAllProviders(query: TransportQueryDto) {
    const where: any = { isActive: true };
    if (query.search) where.companyName = { contains: query.search, mode: 'insensitive' };
    if (query.pickupProvince) where.coverageProvinces = { has: query.pickupProvince };
    if (query.vehicleType) where.vehicleTypes = { has: query.vehicleType };

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);

    const [data, total] = await Promise.all([
      this.prisma.transportProfile.findMany({
        where,
        include: {
          user: { select: { profile: { select: { fullName: true, city: true } } } },
          _count: { select: { requests: true } },
        },
        orderBy: [{ isVerified: 'desc' }, { rating: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transportProfile.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async createRequest(requesterId: string, dto: CreateTransportRequestDto) {
    return this.prisma.transportRequest.create({
      data: {
        requesterId,
        pickupLocation: dto.pickupLocation,
        pickupCity: dto.pickupCity,
        deliveryLocation: dto.deliveryLocation,
        deliveryCity: dto.deliveryCity,
        cargoDescription: dto.cargoDescription,
        cargoWeightTons: dto.cargoWeightTons,
        vehicleType: dto.vehicleType as any,
        requiredDate: dto.requiredDate ? new Date(dto.requiredDate) : null,
        orderId: dto.orderId,
        notes: dto.notes,
      },
    });
  }

  async bookTransport(requesterId: string, dto: BookTransportDto) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: dto.requestId } });
    if (!request) throw new NotFoundException('Transport request not found');
    if (request.requesterId !== requesterId) throw new ForbiddenException('Not your request');

    const provider = await this.prisma.transportProfile.findUnique({ where: { userId: dto.providerId } });
    if (!provider) throw new NotFoundException('Transport provider not found');

    return this.prisma.transportRequest.update({
      where: { id: dto.requestId },
      data: {
        providerId: dto.providerId,
        agreedPrice: dto.agreedPrice,
        status: 'BOOKED',
      },
      include: {
        provider: { include: { user: { select: { profile: { select: { fullName: true } } } } } },
      },
    });
  }

  async updateTracking(requestId: string, providerId: string, data: {
    status?: string;
    currentLocation?: string;
    estimatedArrival?: Date;
    driverName?: string;
    driverPhone?: string;
  }) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your shipment');

    const updateData: any = {};
    if (data.status) updateData.status = data.status;
    if (data.currentLocation) updateData.currentLocation = data.currentLocation;
    if (data.estimatedArrival) updateData.estimatedArrival = data.estimatedArrival;
    if (data.driverName) updateData.driverName = data.driverName;
    if (data.driverPhone) updateData.driverPhone = data.driverPhone;
    if (data.status === 'PICKED_UP') updateData.pickedUpAt = new Date();
    if (data.status === 'DELIVERED') updateData.deliveredAt = new Date();

    return this.prisma.transportRequest.update({ where: { id: requestId }, data: updateData });
  }

  // ─── OPERATOR SELF-SERVICE ──────────────────────────────────────────────
  async registerProvider(userId: string, dto: RegisterProviderDto) {
    const existing = await this.prisma.transportProfile.findUnique({ where: { userId } });
    if (existing) throw new BadRequestException('You already have a transport provider profile');

    return this.prisma.transportProfile.create({
      data: { userId, ...dto } as any,
    });
  }

  async getMyProvider(userId: string) {
    const provider = await this.prisma.transportProfile.findUnique({ where: { userId } });
    if (!provider) throw new NotFoundException('No transport provider profile found');

    const [requests, pending, delivered] = await Promise.all([
      this.prisma.transportRequest.findMany({
        where: { providerId: userId },
        include: { requester: { select: { profile: { select: { fullName: true, city: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.transportRequest.count({ where: { providerId: userId, status: { in: ['BOOKED', 'PICKED_UP', 'IN_TRANSIT'] as any } } }),
      this.prisma.transportRequest.count({ where: { providerId: userId, status: 'DELIVERED' as any } }),
    ]);

    return {
      provider,
      stats: { totalRequests: requests.length, pendingRequests: pending, deliveredRequests: delivered },
      recentRequests: requests,
    };
  }

  async updateMyProvider(userId: string, dto: UpdateProviderDto) {
    const existing = await this.prisma.transportProfile.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('No transport provider profile found');
    return this.prisma.transportProfile.update({ where: { userId }, data: dto as any });
  }

  async getMyRequests(userId: string, role: 'requester' | 'provider') {
    const where = role === 'requester' ? { requesterId: userId } : { providerId: userId };
    return this.prisma.transportRequest.findMany({
      where,
      include: {
        requester: { select: { profile: { select: { fullName: true, city: true } } } },
        provider: { select: { companyName: true, user: { select: { profile: { select: { fullName: true } } } } } },
        order: { select: { id: true, offer: { select: { product: { select: { name: true } } } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async track(requestId: string) {
    const request = await this.prisma.transportRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true, status: true, currentLocation: true, estimatedArrival: true,
        driverName: true, driverPhone: true, pickupCity: true, deliveryCity: true,
        pickedUpAt: true, deliveredAt: true, trackingUrl: true,
      },
    });
    if (!request) throw new NotFoundException('Shipment not found');
    return request;
  }
}
