import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { withAgriConnectId } from '../common/utils/agri-connect-id.util';
import { NotificationType } from '@prisma/client';
import { recordAudit } from '../common/utils/audit.util';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, agriConnectSeq: true, phoneNumber: true, email: true, role: true,
        isPhoneVerified: true, kycStatus: true, createdAt: true,
        kycRejectionNote: true, kycInfoRequestNote: true, kycInfoRequestedAt: true,
        profile: true,
        ratingsReceived: { select: { rating: true, category: true } },
        _count: {
          select: {
            productsAsSeller: true, ordersAsSeller: true,
            ordersAsBuyer: true,
            // Warehouse operators' "listings" are warehouses, not products —
            // without this the profile tab showed 0 listings for them.
            warehouseProfiles: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const ratings = user.ratingsReceived;
    const avgRating = ratings.length > 0
      ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length
      : 0;

    return withAgriConnectId({
      ...user,
      avgRating: Math.round(avgRating * 10) / 10,
      totalReviews: ratings.length,
      ratingsReceived: undefined,
    });
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const existing = await this.prisma.userProfile.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('Profile not found');
    return this.prisma.userProfile.update({
      where: { userId },
      data: dto,
    });
  }

  async getPublicProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, agriConnectSeq: true, role: true, kycStatus: true, createdAt: true,
        profile: {
          select: {
            fullName: true, businessName: true, city: true, province: true,
            profilePhotoUrl: true, cropsGrown: true,
          },
        },
        ratingsReceived: { select: { rating: true, comment: true, category: true, createdAt: true } },
        _count: { select: { productsAsSeller: true, ordersAsSeller: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return withAgriConnectId(user);
  }

  // Admin: list all users
  async adminFindAll(role?: string, kycStatus?: string, search?: string, page = 1, limit = 20) {
    const where: any = {};
    if (role) where.role = role;
    if (kycStatus) where.kycStatus = kycStatus;

    if (search?.trim()) {
      const term = search.trim();
      // "AGC-000123", "AGC000123", or a bare number all resolve to the
      // same underlying sequence lookup — the AgriConnect ID needs to be
      // genuinely searchable (per the plan), not just displayable.
      const idMatch = term.match(/^(?:AGC-?)?0*(\d+)$/i);
      where.OR = [
        { phoneNumber: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
        { profile: { fullName: { contains: term, mode: 'insensitive' } } },
        { profile: { businessName: { contains: term, mode: 'insensitive' } } },
        ...(idMatch ? [{ agriConnectSeq: Number(idMatch[1]) }] : []),
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true, agriConnectSeq: true, phoneNumber: true, email: true, role: true,
          kycStatus: true, isActive: true, createdAt: true,
          profile: { select: { fullName: true, city: true, province: true, businessName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: data.map(withAgriConnectId), meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // Admin: complete user detail — identity, documents, business info, and
  // activity across every module the plan asks for (listings, orders,
  // offers, warehouse bookings, testing/transport requests, transactions).
  // Kept as one query with light `select`s per relation (not full rows) —
  // this is a review screen, not an export, so counts + recent items are
  // enough context for an admin decision without pulling entire histories.
  async adminFindOne(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, agriConnectSeq: true, phoneNumber: true, email: true, role: true,
        isActive: true, isPhoneVerified: true, isEmailVerified: true,
        kycStatus: true, kycApprovedAt: true, kycRejectedAt: true, kycRejectionNote: true,
        kycInfoRequestNote: true, kycInfoRequestedAt: true,
        createdAt: true, updatedAt: true,
        profile: true,
        warehouseProfiles: true,
        testingAgencyProfile: true,
        transportProfile: true,
        kycDocuments: {
          select: { id: true, docType: true, fileUrl: true, status: true, reviewNote: true, reviewedAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
        productsAsSeller: {
          select: { id: true, name: true, status: true, quantity: true, unit: true, askingPrice: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        ordersAsSeller: {
          select: { id: true, status: true, totalAmount: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        ordersAsBuyer: {
          select: { id: true, status: true, totalAmount: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        offersAsBuyer: {
          select: { id: true, status: true, offeredPrice: true, quantity: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        storageBookings: {
          select: { id: true, commodity: true, quantityTons: true, status: true, totalCost: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        warehouseReceipts: {
          select: { id: true, receiptNumber: true, commodity: true, quantityTons: true, status: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        testingRequests: {
          select: { id: true, status: true, servicesRequested: true, fee: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        transportRequests: {
          select: { id: true, status: true, pickupCity: true, deliveryCity: true, agreedPrice: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 10,
        },
        transactions: {
          select: { id: true, type: true, amount: true, description: true, createdAt: true },
          orderBy: { createdAt: 'desc' }, take: 20,
        },
        _count: {
          select: {
            productsAsSeller: true, ordersAsSeller: true, ordersAsBuyer: true,
            offersAsBuyer: true, storageBookings: true, warehouseReceipts: true,
            testingRequests: true, transportRequests: true, transactions: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    return withAgriConnectId(user);
  }

  // Admin: approve / reject KYC. "Request more info" is handled separately
  // by ReviewService.requestClarification (see UsersController.adminKyc) —
  // this method only ever receives APPROVED or REJECTED now.
  // Approving/rejecting the account is the actual decision point — the
  // individual KycDocument rows were otherwise left at their upload-time
  // "pending" status forever, so "My Portal → Documents" kept showing
  // "Pending Review" on every document even long after the account (and
  // implicitly its documents) had been approved. Sync them here so the
  // per-document status reflects the outcome the admin actually decided.
  async adminUpdateKyc(userId: string, status: 'APPROVED' | 'REJECTED', note?: string, actorId?: string) {
    const documentStatus = status === 'APPROVED' ? 'approved' : 'rejected';
    const now = new Date();

    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          kycStatus: status,
          kycApprovedAt: status === 'APPROVED' ? now : null,
          kycRejectedAt: status === 'REJECTED' ? now : null,
          kycRejectionNote: status === 'REJECTED' ? note : null,
        },
      }),
      this.prisma.kycDocument.updateMany({
        where: { userId, status: 'pending' },
        data: {
          status: documentStatus,
          reviewedAt: now,
          ...(status === 'REJECTED' && note ? { reviewNote: note } : {}),
        },
      }),
    ]);

    await recordAudit(this.prisma, actorId, status === 'APPROVED' ? 'kyc_approved' : 'kyc_rejected', 'user', userId, { note });
    await this.notifications.notify({
      userId,
      type: NotificationType.KYC_UPDATE,
      title: status === 'APPROVED' ? 'Your account was approved' : 'Your registration was not approved',
      body: status === 'APPROVED'
        ? 'You can now list, make offers and use every service on AgriConnect.'
        : `Reason: ${note || 'not provided'}. Contact support if you think this is a mistake.`,
      data: { link: '/account' },
    });
    return user;
  }

  // Admin: suspend / activate user
  async adminSetActive(userId: string, isActive: boolean, actorId?: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { isActive } });
    // Suspension must end existing sessions immediately. (Access tokens are
    // also rejected live by JwtStrategy; this stops refresh as well.)
    if (!isActive) {
      await this.prisma.refreshToken.updateMany({ where: { userId }, data: { isRevoked: true } });
    }
    await recordAudit(this.prisma, actorId, isActive ? 'user_reactivated' : 'user_suspended', 'user', userId);
    return user;
  }
}
