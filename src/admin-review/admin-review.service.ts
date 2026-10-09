import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { withResolvedMediaUrls } from '../common/storage/media-url.util';
import { withAgriConnectId } from '../common/utils/agri-connect-id.util';
import { withBookingReferences } from '../common/utils/booking-reference.util';

export const ADMIN_REVIEW_TYPES = ['warehouse', 'testing_agency', 'transport', 'product'] as const;
export type AdminReviewType = (typeof ADMIN_REVIEW_TYPES)[number];

// Owner contact + submitted KYC documents. Bank account / IBAN / CNIC are
// deliberately left out — a listing review doesn't need them, and anyone
// who does can open the full user profile (which has its own access rules).
const OWNER_SELECT = {
  id: true, agriConnectSeq: true, role: true, phoneNumber: true, email: true,
  kycStatus: true, isActive: true, createdAt: true,
  profile: { select: { fullName: true, businessName: true, city: true, province: true, address: true, ntnNumber: true, licenseNumber: true } },
  kycDocuments: { select: { id: true, docType: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' as const } },
};

// One read-only "everything about this listing" view for admins/moderators,
// across every kind of listing that goes through review. The existing admin
// tables only carried a name, city and a couple of flags per row.
@Injectable()
export class AdminReviewService {
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async getDetail(type: string, id: string) {
    if (!ADMIN_REVIEW_TYPES.includes(type as AdminReviewType)) {
      throw new BadRequestException(`Unknown listing type "${type}"`);
    }
    switch (type as AdminReviewType) {
      case 'warehouse': return this.warehouse(id);
      case 'testing_agency': return this.testingAgency(id);
      case 'transport': return this.transport(id);
      case 'product': return this.product(id);
    }
  }

  private shapeOwner(owner: any) {
    return owner ? withAgriConnectId(owner) : null;
  }

  private async listingMedia(entityType: string, entityId: string) {
    const items = await this.prisma.listingMedia.findMany({
      where: { entityType, entityId },
      orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    });
    return withResolvedMediaUrls(this.storage, items);
  }

  private async warehouse(id: string) {
    const w = await this.prisma.warehouseProfile.findUnique({
      where: { id },
      include: { user: { select: OWNER_SELECT } },
    });
    if (!w) throw new NotFoundException('Warehouse not found');
    const { user, ...entity } = w;

    const [media, bookingCount, receiptCount, activeLiens, liens, recentBookings] = await Promise.all([
      this.listingMedia('warehouse', id),
      this.prisma.storageBooking.count({ where: { warehouseId: id } }),
      this.prisma.warehouseReceipt.count({ where: { warehouseId: id } }),
      this.prisma.bankLien.count({ where: { status: 'ACTIVE', receipt: { warehouseId: id } } }),
      this.prisma.bankLien.findMany({
        where: { status: 'ACTIVE', receipt: { warehouseId: id } },
        orderBy: { placedAt: 'desc' },
        select: {
          id: true, bankName: true, loanAmount: true, loanRefNo: true, placedAt: true,
          receipt: { select: { receiptNumber: true, commodity: true, quantityTons: true } },
        },
      }),
      this.prisma.storageBooking.findMany({
        where: { warehouseId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, bookingSeq: true, createdAt: true, commodity: true, quantityTons: true, status: true, totalCost: true },
      }),
    ]);

    return {
      type: 'warehouse',
      entity,
      owner: this.shapeOwner(user),
      media,
      stats: { bookings: bookingCount, receipts: receiptCount, activeLiens },
      activeLienList: liens,
      recentBookings: withBookingReferences(recentBookings),
      clarificationSubject: { subjectType: 'WAREHOUSE_PROFILE', subjectId: id },
    };
  }

  private async testingAgency(id: string) {
    const a = await this.prisma.testingAgencyProfile.findUnique({
      where: { id },
      include: { user: { select: OWNER_SELECT } },
    });
    if (!a) throw new NotFoundException('Testing agency not found');
    const { user, ...entity } = a;
    const [media, requests] = await Promise.all([
      this.listingMedia('testing_agency', id),
      this.prisma.testingRequest.count({ where: { agencyId: a.userId } }),
    ]);
    return {
      type: 'testing_agency',
      entity,
      owner: this.shapeOwner(user),
      media,
      stats: { requests },
      clarificationSubject: { subjectType: 'TESTING_AGENCY_PROFILE', subjectId: id },
    };
  }

  private async transport(id: string) {
    const t = await this.prisma.transportProfile.findUnique({
      where: { id },
      include: { user: { select: OWNER_SELECT } },
    });
    if (!t) throw new NotFoundException('Transport provider not found');
    const { user, ...entity } = t;
    const [media, requests] = await Promise.all([
      this.listingMedia('transport', id),
      this.prisma.transportRequest.count({ where: { providerId: t.userId } }),
    ]);
    return {
      type: 'transport',
      entity,
      owner: this.shapeOwner(user),
      media,
      stats: { requests },
      clarificationSubject: { subjectType: 'TRANSPORT_PROFILE', subjectId: id },
    };
  }

  private async product(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: {
        seller: { select: OWNER_SELECT },
        riceDetails: true,
        media: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        certDocuments: { orderBy: { createdAt: 'desc' } },
        _count: { select: { offers: true, savedBy: true } },
      },
    });
    if (!p) throw new NotFoundException('Listing not found');
    const { seller, media, certDocuments, _count, ...entity } = p;

    // Certificates/lab reports: give each a fresh signed link when it lives
    // in the bucket; legacy rows keep whatever URL they had.
    const docs = await Promise.all(
      certDocuments.map(async (d: any) => ({
        ...d,
        url: d.s3Key && this.storage.isBucketKey(d.s3Key)
          ? await this.storage.getPresignedUrl(d.s3Key, 600)
          : d.fileUrl,
      })),
    );

    return {
      type: 'product',
      entity,
      owner: this.shapeOwner(seller),
      media: await withResolvedMediaUrls(this.storage, media),
      documents: docs,
      stats: { offers: _count.offers, saves: _count.savedBy },
    };
  }
}
