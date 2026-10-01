import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { withResolvedMediaUrls } from '../common/storage/media-url.util';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto/product.dto';
import { ProductStatus, OrderStatus } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  // Round 2, Milestone 4 — every product query below includes `media`
  // (ProductMedia rows). This resolves each one's `url` to a fresh
  // presigned bucket URL (or leaves legacy rows untouched) — see
  // common/storage/media-url.util.ts for the full reasoning.
  private async resolveProductMedia<T extends { media: any[] }>(product: T): Promise<T> {
    return { ...product, media: await withResolvedMediaUrls(this.storage, product.media) };
  }

  private async resolveProductsMedia<T extends { media: any[] }>(products: T[]): Promise<T[]> {
    return Promise.all(products.map((p) => this.resolveProductMedia(p)));
  }

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
        // Listings go live only after admin review — see adminApprove()/
        // adminReject() below. Previously this was ACTIVE immediately,
        // meaning anything a seller submitted appeared on the public
        // marketplace instantly with no review at all.
        status: ProductStatus.PENDING_REVIEW,
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
    const { search, category, province, city, variety, stage, minPrice, maxPrice, verifiedOnly, sortBy, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: any = { status: ProductStatus.ACTIVE };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { locationCity: { contains: search, mode: 'insensitive' } },
        { locationProvince: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { riceDetails: { variety: { contains: search, mode: 'insensitive' } } },
        { seller: { profile: { fullName: { contains: search, mode: 'insensitive' } } } },
        { seller: { profile: { businessName: { contains: search, mode: 'insensitive' } } } },
      ];
    }
    if (category) where.category = category;
    if (province) where.locationProvince = { contains: province, mode: 'insensitive' };
    if (city) where.locationCity = { contains: city, mode: 'insensitive' };
    if (minPrice || maxPrice) {
      where.askingPrice = {};
      if (minPrice) where.askingPrice.gte = minPrice;
      if (maxPrice) where.askingPrice.lte = maxPrice;
    }
    // NOTE: riceDetails filter object must be built in one place — building
    // it incrementally across two separate `if` blocks meant `variety`
    // silently did nothing unless `stage` happened to run first and create
    // the object. Combining them here fixes that.
    if (variety || stage) {
      where.riceDetails = {
        ...(variety && { variety: { contains: variety, mode: 'insensitive' } }),
        ...(stage && { stage }),
      };
    }
    if (verifiedOnly) where.seller = { ...(where.seller || {}), kycStatus: 'APPROVED' };

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
          media: { where: { type: 'image' }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
          _count: { select: { offers: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: await this.resolveProductsMedia(data),
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
      media: await withResolvedMediaUrls(this.storage, product.media),
      seller: {
        ...product.seller,
        avgRating: Math.round(avgRating * 10) / 10,
        totalReviews: ratings.length,
        ratingsReceived: undefined,
      },
    };
  }

  // ─── PUBLIC SELLER PROFILE (marketplace "view seller" click-through) ───────
  async getSellerPublicProfile(sellerId: string) {
    const seller = await this.prisma.user.findFirst({
      // Public marketplace page — restrict to users who actually have at
      // least one product, so this can't be used to probe arbitrary user
      // ids (buyers, warehouse operators, etc. have no "seller" page).
      where: { id: sellerId, productsAsSeller: { some: {} } },
      select: {
        id: true,
        kycStatus: true,
        createdAt: true,
        profile: { select: { fullName: true, businessName: true, city: true, province: true, profilePhotoUrl: true } },
        ratingsReceived: { select: { rating: true }, take: 200 },
      },
    });
    if (!seller) throw new NotFoundException('Seller not found');

    const [listings, completedSalesCount] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where: { sellerId, status: { in: [ProductStatus.ACTIVE, ProductStatus.UNDER_OFFER] } },
        include: { media: { orderBy: { sortOrder: 'asc' }, take: 1 } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.count({ where: { sellerId, status: OrderStatus.COMPLETED } }),
    ]);

    const ratings = seller.ratingsReceived;
    const avgRating = ratings.length > 0 ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length : 0;

    return {
      id: seller.id,
      verified: seller.kycStatus === 'APPROVED',
      memberSince: seller.createdAt,
      fullName: seller.profile?.fullName,
      businessName: seller.profile?.businessName,
      city: seller.profile?.city,
      province: seller.profile?.province,
      profilePhotoUrl: seller.profile?.profilePhotoUrl,
      avgRating: Math.round(avgRating * 10) / 10,
      totalReviews: ratings.length,
      completedSalesCount,
      listings: await Promise.all(listings.map(async (p) => ({
        ...p,
        media: await withResolvedMediaUrls(this.storage, p.media),
        // Shaped to match findOne()'s product.seller so the frontend can
        // run these through the same adaptProduct()/ProductCard it already
        // has, instead of a second bespoke listing shape.
        seller: {
          id: seller.id,
          kycStatus: seller.kycStatus,
          profile: { fullName: seller.profile?.fullName, businessName: seller.profile?.businessName },
          avgRating: Math.round(avgRating * 10) / 10,
        },
      }))),
    };
  }

  // ─── UPDATE ───────────────────────────────────────────────────────────────
  async update(id: string, sellerId: string, dto: UpdateProductDto) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    // Editing a rejected listing is how a seller "resubmits" it — sends it
    // back to admin review rather than leaving it rejected forever, and
    // clears the old rejection note since it no longer applies to the
    // (presumably corrected) new version.
    const resubmitting = product.status === ProductStatus.REJECTED;

    return this.prisma.product.update({
      where: { id },
      data: {
        ...dto,
        ...(resubmitting && { status: ProductStatus.PENDING_REVIEW, rejectionNote: null }),
      },
      include: { riceDetails: true },
    });
  }

  // ─── DELETE (seller's own listing) ─────────────────────────────────────────
  async remove(id: string, sellerId: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
    if (product.status === ProductStatus.SOLD) {
      throw new ForbiddenException('A sold listing is part of your transaction history and cannot be deleted.');
    }

    try {
      await this.prisma.product.delete({ where: { id } });
      return { message: 'Listing deleted.', archived: false };
    } catch (e: any) {
      // Offer.product has no onDelete: Cascade (deliberately — it would
      // silently wipe out a buyer's offer history). A listing that already
      // has offers on it hits that foreign-key constraint (P2003) instead
      // of deleting, so fall back to the same soft-remove admin uses
      // rather than surfacing a raw DB error to the seller.
      if (e?.code === 'P2003') {
        await this.prisma.product.update({ where: { id }, data: { status: ProductStatus.REMOVED } });
        return { message: 'This listing has offers on it, so it was taken off the marketplace instead of permanently deleted.', archived: true };
      }
      throw e;
    }
  }

  // ─── CHANGE STATUS ────────────────────────────────────────────────────────
  // Sellers may only toggle between a small set of safe, already-approved
  // states — never set PENDING_REVIEW/ACTIVE/REJECTED/REMOVED directly.
  // Without this allow-list, a seller could call this exact endpoint with
  // { status: 'ACTIVE' } immediately after create() and bypass admin
  // review entirely — the approval gate above means nothing if this stays
  // wide open.
  private static readonly SELLER_ALLOWED_TRANSITIONS: Partial<Record<ProductStatus, ProductStatus[]>> = {
    [ProductStatus.ACTIVE]: [ProductStatus.PAUSED, ProductStatus.SOLD],
    [ProductStatus.PAUSED]: [ProductStatus.ACTIVE, ProductStatus.SOLD],
  };

  async changeStatus(id: string, sellerId: string, status: ProductStatus) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    const allowed = ProductsService.SELLER_ALLOWED_TRANSITIONS[product.status] || [];
    if (!allowed.includes(status)) {
      throw new ForbiddenException(
        product.status === ProductStatus.PENDING_REVIEW
          ? 'This listing is still awaiting admin review.'
          : product.status === ProductStatus.REJECTED
            ? 'This listing was rejected — edit and save it to resubmit for review.'
            : `Cannot change a ${product.status} listing to ${status}.`,
      );
    }

    return this.prisma.product.update({ where: { id }, data: { status } });
  }

  // ─── UPLOAD MEDIA ─────────────────────────────────────────────────────────
  async addMedia(productId: string, sellerId: string, files: any[], type: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    const existingCount = await this.prisma.productMedia.count({ where: { productId, type: 'image' } });

    const created = await Promise.all(
      files.map((file, index) =>
        this.prisma.productMedia.create({
          data: {
            productId,
            type,
            // Placeholder — real URL is a presigned bucket link generated
            // fresh on every read; `s3Key` (folder-prefixed) is the
            // source of truth. See common/storage/media-url.util.ts.
            url: `/uploads/products/${file.filename}`,
            s3Key: file.filename,
            sortOrder: existingCount + index,
            // First image uploaded becomes the display picture automatically —
            // shown on the marketplace card face. Seller can change it later.
            isPrimary: type === 'image' && existingCount === 0 && index === 0,
          },
        })
      )
    );
    return withResolvedMediaUrls(this.storage, created);
  }

  // Sets which image shows on the listing card face — clears any previous flag first.
  async setPrimaryMedia(mediaId: string, sellerId: string) {
    const media = await this.prisma.productMedia.findUnique({ where: { id: mediaId }, include: { product: true } });
    if (!media) throw new NotFoundException('Media not found');
    if (media.product.sellerId !== sellerId) throw new ForbiddenException('Not your listing');

    await this.prisma.$transaction([
      this.prisma.productMedia.updateMany({ where: { productId: media.productId }, data: { isPrimary: false } }),
      this.prisma.productMedia.update({ where: { id: mediaId }, data: { isPrimary: true } }),
    ]);
    return { message: 'Display picture updated' };
  }

  // ─── SELLER LISTINGS ─────────────────────────────────────────────────────
  async getSellerProducts(sellerId: string) {
    const products = await this.prisma.product.findMany({
      where: { sellerId },
      include: {
        riceDetails: true,
        // Show the display picture specifically — not just "whatever image
        // happens to sort first" — so the seller's own card matches what
        // buyers see on the marketplace.
        media: { where: { type: 'image' }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return this.resolveProductsMedia(products);
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
    const saved = await this.prisma.savedProduct.findMany({
      where: { userId },
      include: {
        product: {
          include: {
            riceDetails: true,
            media: { where: { type: 'image' }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
            seller: { select: { profile: { select: { fullName: true } }, kycStatus: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(
      saved.map(async (s) => ({ ...s, product: await this.resolveProductMedia(s.product) })),
    );
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
   * Admin approves a PENDING_REVIEW listing — this is what actually makes
   * a listing appear on the public marketplace for the first time (see
   * findAll(), which only ever returns status: ACTIVE).
   */
  async adminApprove(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    return this.prisma.product.update({
      where: { id: productId },
      data: { status: ProductStatus.ACTIVE, rejectionNote: null },
    });
  }

  /**
   * Admin declines a PENDING_REVIEW listing. Distinct from adminRemove():
   * REJECTED means it never went live in the first place and the seller
   * can edit + resubmit (see update(), which flips REJECTED back to
   * PENDING_REVIEW automatically on save) — REMOVED means it WAS live and
   * got taken down for fraud/policy violation, a heavier action with no
   * self-service path back.
   */
  async adminReject(productId: string, reason: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    return this.prisma.product.update({
      where: { id: productId },
      data: { status: ProductStatus.REJECTED, rejectionNote: reason },
    });
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
