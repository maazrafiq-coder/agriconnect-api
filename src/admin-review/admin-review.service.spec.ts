import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminReviewService } from './admin-review.service';

describe('AdminReviewService', () => {
  let service: AdminReviewService;
  let prisma: any;
  let storage: any;

  const owner = { id: 'u1', agriConnectSeq: 12, role: 'WAREHOUSE', kycDocuments: [{ id: 'd1', docType: 'cnicFront', status: 'pending' }] };

  beforeEach(() => {
    prisma = {
      warehouseProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'wh-1', name: 'Hub', user: owner }) },
      listingMedia: { findMany: jest.fn().mockResolvedValue([{ id: 'm1', type: 'document', url: 'x', s3Key: null }]) },
      storageBooking: {
        count: jest.fn().mockResolvedValue(4),
        findMany: jest.fn().mockResolvedValue([{ id: 'b1', bookingSeq: 9, createdAt: new Date('2026-02-01') }]),
      },
      warehouseReceipt: { count: jest.fn().mockResolvedValue(2) },
      bankLien: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([]) },
      product: { findUnique: jest.fn() },
    };
    storage = { isBucketKey: jest.fn().mockReturnValue(true), getPresignedUrl: jest.fn().mockResolvedValue('https://signed') };
    service = new AdminReviewService(prisma, storage);
  });

  it('rejects an unknown listing type', async () => {
    await expect(service.getDetail('spaceship', 'x')).rejects.toThrow(BadRequestException);
  });

  it('404s when the warehouse does not exist', async () => {
    prisma.warehouseProfile.findUnique.mockResolvedValue(null);
    await expect(service.getDetail('warehouse', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('returns the whole warehouse picture: entity, owner (with AGC id + KYC docs), media, stats, bookings', async () => {
    const d: any = await service.getDetail('warehouse', 'wh-1');
    expect(d.entity.name).toBe('Hub');
    expect(d.entity.user).toBeUndefined(); // owner is split out, not nested in the entity
    expect(d.owner.agriConnectId).toBe('AGC-000012');
    expect(d.owner.kycDocuments).toHaveLength(1);
    expect(d.media).toHaveLength(1);
    expect(d.stats).toEqual({ bookings: 4, receipts: 2, activeLiens: 1 });
    expect(d.recentBookings[0].bookingReference).toBe('WHB-2026-000009');
    expect(d.clarificationSubject).toEqual({ subjectType: 'WAREHOUSE_PROFILE', subjectId: 'wh-1' });
  });

  it('gives product certificates a fresh signed link', async () => {
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1', name: 'Basmati', seller: owner, riceDetails: null, media: [],
      certDocuments: [{ id: 'c1', s3Key: 'docs/c1.pdf', fileUrl: '/old' }], _count: { offers: 3, savedBy: 1 },
    });
    const d: any = await service.getDetail('product', 'p1');
    expect(d.documents[0].url).toBe('https://signed');
    expect(d.stats).toEqual({ offers: 3, saves: 1 });
  });
});
