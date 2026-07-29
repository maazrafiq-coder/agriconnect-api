import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto/product.dto';
import { ProductStatus } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  // ─── CREATE ───────────────────────────────────────────────────────────────
  async create(sellerId: string, dto: CreateProductDto) {
    const { riceDetails, ...productData } = dto;

    // Category is now admin-managed data, not a hardcoded enum — validate
    // the slug is real and active so listings can't reference a category
    // an admin removed or that never existed.
    const category = await this.prisma.category.findUnique({ where: { slug: productData.category } });
    if (!category || !category.isActive) {
      throw new BadRequestException(`"${productData.category}" is not a valid or active category`);
    }

    // Units are scoped per-category (e.g. "Bales" only valid for Cotton) or
    // global (e.g. "kg" valid everywhere). Confirm the chosen unit is
    // actually offered for this category before accepting the listing.
    const validUnit = await this.prisma.unit.findFirst({
      where: {
        name: productData.unit,
        isActive: true,
        OR: [{ categoryId: null }, { categoryId: category.id }],
      },
    });
    if (!validUnit) {
      throw new BadRequestException(`"${productData.unit}" is not a valid unit for the "${category.name}" category`);
    }

    const product = await this.prisma.product.create({
      data: {
        ...productData,
        askingPrice: productData.askingPrice,
        sellerId,
        harvestDate: productData.harvestDate ? new Date(productData.harvestDate) : null,
        status: ProductStatus.ACTIVE,
        ...(riceDetails && {
          riceDetails: { create: riceDetails },
        }),
      },
      include: {
        riceDetails: true,
        seller: { select: { id: true, profile: { select: { fullName: true, city: true } }, kycStatus: true } },
      },
    });

    return product;
  }

  // ─── FIND ALL (with search & filters) ─────────────────────────────────────
  async findAll(query: ProductQueryDto) {
    const { search, category, province, variety, stage, minPrice, maxPrice, verifiedOnly, sortBy, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = { status: ProductStatus.ACTIVE };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { locationCity: { contains: search, mode: 'insensitive' } },
        { riceDetails: { variety: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (category) where.category = category;
    if (province) where.locationProvince = { contains: province, mode: 'insensitive' };
    if (minPrice || maxPrice) {
      where.askingPrice = {};
      if (minPrice) where.askingPrice.gte = minPrice;
      if (maxPrice) where.askingPrice.lte = maxPrice;
    }
    if (variety && where.riceDetails) where.riceDetails.variety = { contains: variety, mode: 'insensitive' };
    if (stage) where.riceDetails = { ...where.riceDetails, stage };
    if (verifiedOnly) where.seller = { kycStatus: 'APPROVED' };

    const orderBy: any = (() => {
      switch (sortBy) {
        case 'price_asc': return { askingPrice: 'asc' };
        case 'price_desc': return { askingPrice: 'desc' };
        case 'newest': return { createdAt: 'desc' };
        default: return [{ viewCount: 'desc' }, { createdAt: 'desc' }];
      }
    })();

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          riceDetails: true,
          seller: {
            select: {
              id: true,
              kycStatus: true,
              profile: { select: { fullName: true, city: true, profilePhotoUrl: true } },
            },
          },
          media: { where: { type: 'image' }, take: 1, orderBy: { sortOrder: 'asc' } },
          _count: { select: { offers: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────────────────
  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        riceDetails: true,
        seller: {
          select: {
            id: true,
            kycStatus: true,
            createdAt: true,
            profile: true,
            ratingsReceived: {
              select: { rating: true },
              take: 100,
            },
          },
        },
        media: { orderBy: { sortOrder: 'asc' } },
        certDocuments: true,
        _count: { select: { offers: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    // Increment view count
    await this.prisma.product.update({ where: { id }, data: { viewCount: { increment: 1 } } });

    // Calculate seller rating
    const ratings = product.seller.ratingsReceived;
    const avgRating = ratings.length > 0
      ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
      : 0;

    return {
      ...product,
      seller: {
        ...product.seller,
        avgRating: Math.round(avgRating * 10) / 10,
        totalReviews: ratings.length,
        ratingsReceived: undefined,
      },
    };
  }

  // ─── UPDATE ───────────────────────────────────────────────────────────────
  async update(id: string, sellerId: string, dto: UpdateProductDto) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    return this.prisma.product.update({
      where: { id },
      data: { ...dto },
      include: { riceDetails: true },
    });
  }

  // ─── CHANGE STATUS ────────────────────────────────────────────────────────
  async changeStatus(id: string, sellerId: string, status: ProductStatus) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    return this.prisma.product.update({ where: { id }, data: { status } });
  }

  // ─── UPLOAD MEDIA ─────────────────────────────────────────────────────────
  async addMedia(productId: string, sellerId: string, files: any[], type: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    const created = await Promise.all(
      files.map((file, index) =>
        this.prisma.productMedia.create({
          data: {
            productId,
            type,
            url: `/uploads/products/${file.filename}`,
            s3Key: file.filename,
            sortOrder: index,
          },
        })
      )
    );
    return created;
  }

  // ─── SELLER LISTINGS ─────────────────────────────────────────────────────
  async getSellerProducts(sellerId: string) {
    return this.prisma.product.findMany({
      where: { sellerId },
      include: {
        riceDetails: true,
        media: { where: { type: 'image' }, take: 1 },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── SAVE PRODUCT ─────────────────────────────────────────────────────────
  async saveProduct(userId: string, productId: string) {
    const existing = await this.prisma.savedProduct.findUnique({
      where: { userId_productId: { userId, productId } },
    });
    if (existing) {
      await this.prisma.savedProduct.delete({ where: { id: existing.id } });
      return { saved: false };
    }
    await this.prisma.savedProduct.create({ data: { userId, productId } });
    return { saved: true };
  }

  // ─── SAVED PRODUCTS ───────────────────────────────────────────────────────
  async getSavedProducts(userId: string) {
    return this.prisma.savedProduct.findMany({
      where: { userId },
      include: {
        product: {
          include: {
            riceDetails: true,
            media: { where: { type: 'image' }, take: 1 },
            seller: { select: { profile: { select: { fullName: true } }, kycStatus: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── ADMIN MODERATION ─────────────────────────────────────────────────────
  // The PRD calls for "Review Listings / Remove Fraudulent Listings" in the
  // admin portal. These were previously missing entirely.

  async adminFindAll(status?: ProductStatus, page = 1, limit = 20) {
    const where: any = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          seller: { select: { id: true, kycStatus: true, profile: { select: { fullName: true } } } },
          riceDetails: true,
          _count: { select: { offers: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Admin removes a listing for fraud/policy violation. Unlike the seller's
   * own changeStatus(), this bypasses the ownership check entirely — an
   * admin can act on any listing — and records the reason for audit.
   */
  async adminRemove(productId: string, reason: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    return this.prisma.product.update({
      where: { id: productId },
      data: { status: ProductStatus.REMOVED, description: `${product.description || ''}\n\n[REMOVED BY ADMIN: ${reason}]`.trim() },
    });
  }

  async adminRestore(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    return this.prisma.product.update({ where: { id: productId }, data: { status: ProductStatus.ACTIVE } });
  }
}
