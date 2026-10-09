// ─── TESTING SERVICE ──────────────────────────────────────────────────────────
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TestingStatus, PaymentStatus, NotificationType } from '@prisma/client';
import { recordAudit } from '../common/utils/audit.util';
import { NotificationsService } from '../notifications/notifications.service';
import { IsString, IsNumber, IsOptional, IsArray, IsDateString, IsBoolean, IsIn, IsPositive, MinLength, Min } from 'class-validator';
import { StorageService } from '../common/storage/storage.service';

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
  // A report is a file uploaded earlier (POST …/report-file), a link, or
  // structured results — at least one is required (checked in the service).
  @IsOptional() @IsString() reportUrl?: string;
  @IsOptional() reportData?: any;
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
  constructor(private prisma: PrismaService, private notifications: NotificationsService, private storage: StorageService) {}

  // Admin: delist a testing agency without touching the underlying account
  async adminSetActive(agencyId: string, isActive: boolean, actorId?: string) {
    const agency = await this.prisma.testingAgencyProfile.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Testing agency not found');
    const res = await this.prisma.testingAgencyProfile.update({ where: { id: agencyId }, data: { isActive } });
    await recordAudit(this.prisma, actorId, isActive ? 'testing_agency_relisted' : 'testing_agency_delisted', 'testing_agency', agencyId);
    return res;
  }

  // Admin: mark a testing agency as verified/unverified — a trust signal
  // shown to buyers, separate from isActive (listed/delisted). Round 2,
  // Milestone 6: this mirrors WarehouseService.adminVerify, which
  // existed for warehouses but had no equivalent here or on
  // TransportService, despite TestingAgencyProfile/TransportProfile
  // both already having an `isVerified` column (used in this file's own
  // findAllAgencies sort order below) with no way to ever set it true.
  async adminVerify(agencyId: string, verified: boolean, actorId?: string) {
    const agency = await this.prisma.testingAgencyProfile.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Testing agency not found');
    const res = await this.prisma.testingAgencyProfile.update({ where: { id: agencyId }, data: { isVerified: verified } });
    await recordAudit(this.prisma, actorId, verified ? 'testing_agency_verified' : 'testing_agency_unverified', 'testing_agency', agencyId);
    return res;
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

    const hasReport = !!(dto.reportUrl?.trim() || request.reportFileKey || (dto.reportData && Object.keys(dto.reportData).length));
    if (!hasReport) {
      throw new BadRequestException('Attach the report file (or enter the results) before submitting');
    }

    const done = await this.prisma.testingRequest.update({
      where: { id: requestId },
      data: {
        reportUrl: dto.reportUrl?.trim() || undefined,
        reportData: dto.reportData,
        status: TestingStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
    await this.notifications.notify({
      userId: request.requesterId,
      type: NotificationType.TESTING_UPDATE,
      title: 'Your test report is ready',
      body: 'The testing agency has submitted the report for your request.',
      data: { link: '/buyer', requestId },
    });
    return done;
  }

  // The agency uploads the report document. It is stored under a permanent
  // key; downloads get a freshly signed link every time (the previous flow
  // had the agency paste a temporary link that expired after an hour).
  async uploadReportFile(requestId: string, agencyId: string, file: { filename?: string; originalname?: string } | undefined) {
    if (!file?.filename) throw new BadRequestException('Attach a PDF or image file');
    const request = await this.prisma.testingRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.agencyId !== agencyId) throw new ForbiddenException('Not your request');
    if (request.status === TestingStatus.CANCELLED) {
      throw new BadRequestException('This request was cancelled');
    }
    // Reports are final once submitted — replacing the file after the
    // requester was told it is ready would silently change their evidence.
    if (request.status === TestingStatus.COMPLETED) {
      throw new BadRequestException('The report was already submitted and can no longer be replaced');
    }
    await this.prisma.testingRequest.update({
      where: { id: requestId },
      data: { reportFileKey: file.filename, reportFileName: file.originalname || 'report' },
    });
    return { message: 'File attached. Submit the report to finish.', fileName: file.originalname || 'report' };
  }

  async getReportFile(requestId: string, userId: string, role: string) {
    const request = await this.prisma.testingRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    const allowed = request.requesterId === userId || request.agencyId === userId || role === 'ADMIN' || role === 'MODERATOR';
    // Same 404 as "no file", so request ids can't be probed.
    if (!allowed || !request.reportFileKey) throw new NotFoundException('No report file found');
    // A requester only sees the file once the agency has submitted the report.
    if (request.requesterId === userId && request.status !== TestingStatus.COMPLETED) {
      throw new NotFoundException('No report file found');
    }
    const url = await this.storage.getPresignedUrl(request.reportFileKey, 600);
    return { url, fileName: request.reportFileName || 'report' };
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

    const updated = await this.prisma.testingRequest.update({ where: { id: requestId }, data: { status } });
    const other = party === 'agency' ? request.requesterId : request.agencyId;
    if (other) {
      await this.notifications.notify({
        userId: other,
        type: NotificationType.TESTING_UPDATE,
        title: `Testing request ${status.toLowerCase().replace('_', ' ')}`,
        body: `A testing request is now ${status.replace('_', ' ').toLowerCase()}.`,
        data: { link: party === 'agency' ? '/buyer' : '/testing-portal', requestId },
      });
    }
    return updated;
  }
}

// ─── TRANSPORT SERVICE ────────────────────────────────────────────────────────
export class CreateTransportRequestDto {
  // Optional: send the request straight to one provider for a quote.
  @IsOptional() @IsString() providerId?: string;
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

// "Book" now means: ask this provider to quote the request. The price is
// set by the provider's quote and fixed when the requester accepts it — the
// client can no longer dictate (or default to 0) the agreed price.
export class BookTransportDto {
  @IsString() requestId: string;
  @IsString() providerId: string;
  @IsOptional() @IsNumber() @Min(0) agreedPrice?: number; // ignored; kept so older clients don't break
}

export class QuoteTransportDto {
  @IsNumber() @IsPositive() price: number;
  @IsOptional() @IsDateString() estimatedArrival?: string;
  @IsOptional() @IsString() note?: string;
}

export class TrackingUpdateDto {
  @IsOptional() @IsIn(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED']) status?: 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED';
  @IsOptional() @IsString() currentLocation?: string;
  @IsOptional() @IsDateString() estimatedArrival?: string;
  @IsOptional() @IsString() driverName?: string;
  @IsOptional() @IsString() driverPhone?: string;
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
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  // Admin: delist a transport provider without touching the underlying account
  async adminSetActive(providerId: string, isActive: boolean, actorId?: string) {
    const provider = await this.prisma.transportProfile.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException('Transport provider not found');
    const res = await this.prisma.transportProfile.update({ where: { id: providerId }, data: { isActive } });
    await recordAudit(this.prisma, actorId, isActive ? 'transport_relisted' : 'transport_delisted', 'transport', providerId);
    return res;
  }

  // Admin: mark a transport provider as verified/unverified — see
  // TestingService.adminVerify above for the full reasoning. Round 2,
  // Milestone 6.
  async adminVerify(providerId: string, verified: boolean, actorId?: string) {
    const provider = await this.prisma.transportProfile.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException('Transport provider not found');
    const res = await this.prisma.transportProfile.update({ where: { id: providerId }, data: { isVerified: verified } });
    await recordAudit(this.prisma, actorId, verified ? 'transport_verified' : 'transport_unverified', 'transport', providerId);
    return res;
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

  private async assertProvider(providerUserId: string) {
    const provider = await this.prisma.transportProfile.findUnique({ where: { userId: providerUserId } });
    if (!provider || !provider.isActive) throw new NotFoundException('Transport provider not found');
    return provider;
  }

  private async notifyProvider(request: { id: string; pickupCity: string; deliveryCity: string }, providerId: string) {
    await this.notifications.notify({
      userId: providerId,
      type: NotificationType.TRANSPORT_UPDATE,
      title: 'New transport request — quote needed',
      body: `${request.pickupCity} → ${request.deliveryCity}. Open your portal to send a price.`,
      data: { link: '/transport-portal', requestId: request.id },
    });
  }

  async createRequest(requesterId: string, dto: CreateTransportRequestDto) {
    if (dto.providerId) await this.assertProvider(dto.providerId);
    const created = await this.prisma.transportRequest.create({
      data: {
        requesterId,
        providerId: dto.providerId,
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
    if (dto.providerId) await this.notifyProvider(created, dto.providerId);
    return created;
  }

  // Sends (or re-sends) an existing request to a provider for a quote. No
  // price is set here — see quote() / acceptQuote().
  async bookTransport(requesterId: string, dto: BookTransportDto) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: dto.requestId } });
    if (!request) throw new NotFoundException('Transport request not found');
    if (request.requesterId !== requesterId) throw new ForbiddenException('Not your request');
    if (!['REQUESTED', 'QUOTED'].includes(request.status)) {
      throw new BadRequestException(`This request is already ${request.status.toLowerCase().replace('_', ' ')}`);
    }
    await this.assertProvider(dto.providerId);

    const updated = await this.prisma.transportRequest.update({
      where: { id: dto.requestId },
      data: { providerId: dto.providerId, status: 'REQUESTED', quotedPrice: null, quoteNote: null, quotedAt: null, agreedPrice: null },
      include: {
        provider: { include: { user: { select: { profile: { select: { fullName: true } } } } } },
      },
    });
    await this.notifyProvider(updated, dto.providerId);
    return updated;
  }

  // Provider answers a request with a price (and optional ETA / note).
  async quote(requestId: string, providerId: string, dto: QuoteTransportDto) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your request');
    if (!['REQUESTED', 'QUOTED'].includes(request.status)) {
      throw new BadRequestException(`A quote can't be sent while the request is ${request.status.toLowerCase().replace('_', ' ')}`);
    }
    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, providerId, status: { in: ['REQUESTED', 'QUOTED'] as any } },
      data: {
        status: 'QUOTED' as any,
        quotedPrice: dto.price,
        quoteNote: dto.note?.trim() || null,
        quotedAt: new Date(),
        ...(dto.estimatedArrival && { estimatedArrival: new Date(dto.estimatedArrival) }),
      },
    });
    if (res.count === 0) throw new BadRequestException('This request was just updated — refresh and try again');
    await this.notifications.notify({
      userId: request.requesterId,
      type: NotificationType.TRANSPORT_UPDATE,
      title: 'You received a transport quote',
      body: `₨${Number(dto.price).toLocaleString()} for ${request.pickupCity} → ${request.deliveryCity}. Accept it to confirm the booking.`,
      data: { link: '/buyer', requestId },
    });
    return this.prisma.transportRequest.findUnique({ where: { id: requestId } });
  }

  // Requester accepts the quote: the agreed price is the QUOTED price.
  async acceptQuote(requestId: string, requesterId: string) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.requesterId !== requesterId) throw new ForbiddenException('Not your request');
    if (request.status !== 'QUOTED' || request.quotedPrice == null || !request.providerId) {
      throw new BadRequestException('There is no quote to accept on this request');
    }
    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, status: 'QUOTED' as any, quotedPrice: request.quotedPrice },
      data: { status: 'BOOKED' as any, agreedPrice: request.quotedPrice },
    });
    if (res.count === 0) throw new BadRequestException('The quote changed — review the new price and accept again');
    await this.notifications.notify({
      userId: request.providerId,
      type: NotificationType.TRANSPORT_UPDATE,
      title: 'Quote accepted — shipment booked',
      body: `₨${Number(request.quotedPrice).toLocaleString()} for ${request.pickupCity} → ${request.deliveryCity}.`,
      data: { link: '/transport-portal', requestId },
    });
    return this.prisma.transportRequest.findUnique({ where: { id: requestId } });
  }

  // Provider turns a request down; it returns to the requester unassigned
  // so they can pick another provider.
  async declineRequest(requestId: string, providerId: string, reason?: string) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your request');
    if (!['REQUESTED', 'QUOTED'].includes(request.status)) {
      throw new BadRequestException('Only requests awaiting a quote or acceptance can be declined');
    }
    const why = (reason || '').trim();
    if (why.length < 5) throw new BadRequestException('Give the requester a short reason (at least 5 characters)');
    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, providerId, status: { in: ['REQUESTED', 'QUOTED'] as any } },
      data: { providerId: null, status: 'REQUESTED' as any, quotedPrice: null, quoteNote: null, quotedAt: null },
    });
    if (res.count === 0) throw new BadRequestException('This request was just updated — refresh and try again');
    await this.notifications.notify({
      userId: request.requesterId,
      type: NotificationType.TRANSPORT_UPDATE,
      title: 'A transporter declined your request',
      body: `${request.pickupCity} → ${request.deliveryCity}: ${why}. You can send it to another provider.`,
      data: { link: '/buyer', requestId },
    });
    return { message: 'Request declined' };
  }

  async cancelRequest(requestId: string, requesterId: string) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.requesterId !== requesterId) throw new ForbiddenException('Not your request');
    if (!['REQUESTED', 'QUOTED', 'BOOKED'].includes(request.status)) {
      throw new BadRequestException('This shipment has already been picked up and can no longer be cancelled');
    }
    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, status: { in: ['REQUESTED', 'QUOTED', 'BOOKED'] as any } },
      data: { status: 'CANCELLED' as any },
    });
    if (res.count === 0) throw new BadRequestException('This request was just updated — refresh and try again');
    if (request.providerId) {
      await this.notifications.notify({
        userId: request.providerId,
        type: NotificationType.TRANSPORT_UPDATE,
        title: 'Transport request cancelled',
        body: `${request.pickupCity} → ${request.deliveryCity} was cancelled by the requester.`,
        data: { link: '/transport-portal', requestId },
      });
    }
    return { message: 'Request cancelled' };
  }

  private static readonly TRACKING_NEXT: Record<string, string[]> = {
    BOOKED: ['PICKED_UP'],
    PICKED_UP: ['IN_TRANSIT', 'DELIVERED'],
    IN_TRANSIT: ['DELIVERED'],
  };

  async updateTracking(requestId: string, providerId: string, data: TrackingUpdateDto) {
    const request = await this.prisma.transportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your shipment');
    // Tracking only makes sense for a confirmed, live shipment — never on
    // a request that is still being quoted, or already delivered/cancelled.
    if (!['BOOKED', 'PICKED_UP', 'IN_TRANSIT'].includes(request.status)) {
      throw new BadRequestException(`Tracking can't be updated while the shipment is ${request.status.toLowerCase().replace('_', ' ')}`);
    }
    if (data.status && !TransportService.TRACKING_NEXT[request.status]?.includes(data.status)) {
      throw new BadRequestException(`A shipment can't move from ${request.status} to ${data.status}`);
    }

    const updateData: any = {};
    if (data.status) updateData.status = data.status;
    if (data.currentLocation) updateData.currentLocation = data.currentLocation;
    if (data.estimatedArrival) updateData.estimatedArrival = new Date(data.estimatedArrival);
    if (data.driverName) updateData.driverName = data.driverName;
    if (data.driverPhone) updateData.driverPhone = data.driverPhone;
    if (data.status === 'PICKED_UP') updateData.pickedUpAt = new Date();
    if (data.status === 'DELIVERED') updateData.deliveredAt = new Date();

    const res = await this.prisma.transportRequest.updateMany({
      where: { id: requestId, status: request.status },
      data: updateData,
    });
    if (res.count === 0) throw new BadRequestException('This shipment was just updated — refresh and try again');

    if (data.status) {
      await this.notifications.notify({
        userId: request.requesterId,
        type: NotificationType.TRANSPORT_UPDATE,
        title: `Shipment ${data.status.toLowerCase().replace('_', ' ')}`,
        body: `${request.pickupCity} → ${request.deliveryCity} is now ${data.status.toLowerCase().replace('_', ' ')}${data.currentLocation ? ` (${data.currentLocation})` : ''}.`,
        data: { link: '/buyer', requestId },
      });
    }
    return this.prisma.transportRequest.findUnique({ where: { id: requestId } });
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

  // Public (no login) — the driver's phone number is deliberately NOT
  // returned here; anyone holding a shipment id could otherwise read it.
  async track(requestId: string) {
    const request = await this.prisma.transportRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true, status: true, currentLocation: true, estimatedArrival: true,
        driverName: true, pickupCity: true, deliveryCity: true,
        pickedUpAt: true, deliveredAt: true, trackingUrl: true,
      },
    });
    if (!request) throw new NotFoundException('Shipment not found');
    return request;
  }
}
