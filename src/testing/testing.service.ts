// ─── TESTING SERVICE ──────────────────────────────────────────────────────────
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TestingStatus, PaymentStatus } from '@prisma/client';
import { IsString, IsNumber, IsOptional, IsArray, IsDateString, Min } from 'class-validator';

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
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() service?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsNumber() @Min(1) page?: number = 1;
  @IsOptional() @IsNumber() @Min(1) limit?: number = 20;
}

@Injectable()
export class TestingService {
  constructor(private prisma: PrismaService) {}

  async findAllAgencies(query: AgencyQueryDto) {
    const where: any = { isActive: true };
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
    if (request.agencyId !== userId && request.requesterId !== userId) throw new ForbiddenException('Access denied');
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
  @IsOptional() @IsString() pickupProvince?: string;
  @IsOptional() @IsString() deliveryProvince?: string;
  @IsOptional() @IsString() vehicleType?: string;
  @IsOptional() @IsNumber() @Min(1) page?: number = 1;
  @IsOptional() @IsNumber() @Min(1) limit?: number = 20;
}

@Injectable()
export class TransportService {
  constructor(private prisma: PrismaService) {}

  async findAllProviders(query: TransportQueryDto) {
    const where: any = { isActive: true };
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
