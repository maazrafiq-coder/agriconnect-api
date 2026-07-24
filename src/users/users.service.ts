// src/users/users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, phoneNumber: true, email: true, role: true,
        isPhoneVerified: true, kycStatus: true, createdAt: true,
        profile: true,
        ratingsReceived: { select: { rating: true, category: true } },
        _count: {
          select: {
            productsAsSeller: true, ordersAsSeller: true,
            ordersAsBuyer: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const ratings = user.ratingsReceived;
    const avgRating = ratings.length > 0
      ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length
      : 0;

    return {
      ...user,
      avgRating: Math.round(avgRating * 10) / 10,
      totalReviews: ratings.length,
      ratingsReceived: undefined,
    };
  }

  async updateProfile(userId: string, data: any) {
    return this.prisma.userProfile.update({
      where: { userId },
      data,
    });
  }

  async getPublicProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, role: true, kycStatus: true, createdAt: true,
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
    return user;
  }

  // Admin: list all users
  async adminFindAll(role?: string, kycStatus?: string, page = 1, limit = 20) {
    const where: any = {};
    if (role) where.role = role;
    if (kycStatus) where.kycStatus = kycStatus;

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true, phoneNumber: true, email: true, role: true,
          kycStatus: true, isActive: true, createdAt: true,
          profile: { select: { fullName: true, city: true, province: true, businessName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // Admin: approve / reject KYC
  async adminUpdateKyc(userId: string, status: 'APPROVED' | 'REJECTED', note?: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        kycStatus: status,
        kycApprovedAt: status === 'APPROVED' ? new Date() : null,
        kycRejectedAt: status === 'REJECTED' ? new Date() : null,
        kycRejectionNote: note,
      },
    });
  }

  // Admin: suspend / activate user
  async adminSetActive(userId: string, isActive: boolean) {
    return this.prisma.user.update({ where: { id: userId }, data: { isActive } });
  }
}
