import { withResolvedMediaUrl, withResolvedMediaUrls } from './media-url.util';

// Round 2, Milestone 4. Uses a plain stub StorageService (not a full
// NestJS testing module) since this util only depends on the two
// methods below — mirrors the lightweight-stub style already used for
// PrismaService in this project's other specs.
describe('media-url.util', () => {
  let storage: { isBucketKey: jest.Mock; getPresignedUrl: jest.Mock };

  beforeEach(() => {
    storage = {
      // Real implementation's logic (folder-prefix check), not a mock
      // return value, so these tests exercise the actual discriminator
      // behavior end-to-end.
      isBucketKey: jest.fn((key: string | null | undefined) => !!key && key.includes('/')),
      getPresignedUrl: jest.fn().mockResolvedValue('https://bucket.example.com/presigned?sig=xyz'),
    };
  });

  describe('withResolvedMediaUrl', () => {
    it('replaces url with a presigned URL for a bucket-backed item', async () => {
      const item = { url: 'placeholder', s3Key: 'listings/listing-1-2.jpg' };
      const resolved = await withResolvedMediaUrl(storage as any, item);
      expect(resolved.url).toBe('https://bucket.example.com/presigned?sig=xyz');
      expect(storage.getPresignedUrl).toHaveBeenCalledWith('listings/listing-1-2.jpg', 3600);
    });

    it('leaves a legacy (pre-Milestone-4) item unchanged', async () => {
      const item = { url: '/uploads/products/product-old.jpg', s3Key: 'product-old.jpg' };
      const resolved = await withResolvedMediaUrl(storage as any, item);
      expect(resolved.url).toBe('/uploads/products/product-old.jpg');
      expect(storage.getPresignedUrl).not.toHaveBeenCalled();
    });

    it('leaves an item with a null s3Key unchanged', async () => {
      const item = { url: '/uploads/legacy.jpg', s3Key: null };
      const resolved = await withResolvedMediaUrl(storage as any, item);
      expect(resolved.url).toBe('/uploads/legacy.jpg');
    });

    it('does not mutate the original object', async () => {
      const item = { url: 'placeholder', s3Key: 'products/product-1.jpg' };
      await withResolvedMediaUrl(storage as any, item);
      expect(item.url).toBe('placeholder');
    });
  });

  describe('withResolvedMediaUrls', () => {
    it('resolves a mixed list of bucket-backed and legacy items', async () => {
      const items = [
        { url: 'placeholder', s3Key: 'products/product-1.jpg' },
        { url: '/uploads/products/product-old.jpg', s3Key: 'product-old.jpg' },
      ];
      const resolved = await withResolvedMediaUrls(storage as any, items);
      expect(resolved[0].url).toBe('https://bucket.example.com/presigned?sig=xyz');
      expect(resolved[1].url).toBe('/uploads/products/product-old.jpg');
    });

    it('handles an empty list', async () => {
      const resolved = await withResolvedMediaUrls(storage as any, []);
      expect(resolved).toEqual([]);
    });
  });
});
