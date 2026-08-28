import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';

/**
 * Round 2, Milestone 4 — persistent file storage.
 *
 * Covers: uploaded ListingMedia rows get a fresh presigned URL (not the
 * placeholder `url` stored at write time); ownership is still checked
 * before any write, same as before this milestone; removing a
 * bucket-backed media row also deletes the underlying bucket object,
 * while a legacy (pre-Milestone-4) row is left alone since there's
 * nothing in the bucket to delete for it.
 */
describe('MediaService — Milestone 4 storage integration', () => {
  let service: MediaService;
  let prisma: any;
  let storage: any;

  const warehouse = { id: 'wh-1', userId: 'owner-1' };

  beforeEach(async () => {
    prisma = {
      warehouseProfile: { findUnique: jest.fn().mockResolvedValue(warehouse) },
      testingAgencyProfile: { findUnique: jest.fn() },
      transportProfile: { findUnique: jest.fn() },
      listingMedia: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'media-1', ...data })),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    storage = {
      isBucketKey: jest.fn((key: string | null) => !!key && key.includes('/')),
      getPresignedUrl: jest.fn().mockResolvedValue('https://bucket.example.com/presigned'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = moduleRef.get(MediaService);
  });

  describe('upload', () => {
    it('rejects a user who does not own the warehouse', async () => {
      prisma.warehouseProfile.findUnique.mockResolvedValue({ id: 'wh-1', userId: 'someone-else' });
      await expect(
        service.upload('warehouse', 'wh-1', 'owner-1', [{ filename: 'listings/listing-1.jpg' }], 'image'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('stores the folder-prefixed s3Key and returns a presigned url', async () => {
      const [created] = await service.upload(
        'warehouse', 'wh-1', 'owner-1', [{ filename: 'listings/listing-1-2.jpg' }], 'image',
      );
      expect(prisma.listingMedia.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ s3Key: 'listings/listing-1-2.jpg' }),
        }),
      );
      expect(created.url).toBe('https://bucket.example.com/presigned');
    });
  });

  describe('list', () => {
    it('resolves every item to a fresh presigned url', async () => {
      prisma.listingMedia.findMany.mockResolvedValue([
        { id: 'm1', url: 'placeholder', s3Key: 'listings/listing-1.jpg' },
        { id: 'm2', url: 'placeholder', s3Key: 'listings/listing-2.jpg' },
      ]);
      const result = await service.list('warehouse', 'wh-1');
      expect(result).toHaveLength(2);
      expect(result.every((m) => m.url === 'https://bucket.example.com/presigned')).toBe(true);
    });

    it('leaves a legacy pre-Milestone-4 row untouched', async () => {
      prisma.listingMedia.findMany.mockResolvedValue([
        { id: 'm1', url: '/uploads/listings/old.jpg', s3Key: 'old.jpg' },
      ]);
      const [result] = await service.list('warehouse', 'wh-1');
      expect(result.url).toBe('/uploads/listings/old.jpg');
      expect(storage.getPresignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the bucket object for a bucket-backed row', async () => {
      prisma.listingMedia.findUnique.mockResolvedValue({
        id: 'm1', entityType: 'warehouse', entityId: 'wh-1', s3Key: 'listings/listing-1.jpg',
      });
      await service.remove('m1', 'owner-1');
      expect(storage.deleteObject).toHaveBeenCalledWith('listings/listing-1.jpg');
    });

    it('does not attempt a bucket delete for a legacy row', async () => {
      prisma.listingMedia.findUnique.mockResolvedValue({
        id: 'm1', entityType: 'warehouse', entityId: 'wh-1', s3Key: 'old.jpg',
      });
      await service.remove('m1', 'owner-1');
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('rejects removal by a non-owner', async () => {
      prisma.listingMedia.findUnique.mockResolvedValue({
        id: 'm1', entityType: 'warehouse', entityId: 'wh-1', s3Key: 'listings/listing-1.jpg',
      });
      await expect(service.remove('m1', 'random-user')).rejects.toThrow(ForbiddenException);
    });

    it('404s on a missing media row', async () => {
      prisma.listingMedia.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing', 'owner-1')).rejects.toThrow(NotFoundException);
    });
  });
});
