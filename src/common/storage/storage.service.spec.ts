import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

// Round 2, Milestone 4 — persistent file storage (Railway Storage Buckets).
//
// Mocks the AWS SDK v3 clients directly (jest.mock on the two packages)
// rather than hitting a real bucket — mirrors the PrismaService-stub
// pattern used throughout this project's other specs: verify our own
// wrapper logic (bucket/key wiring, error-swallowing on delete, the
// legacy-vs-bucket-key discriminator), not the SDK/bucket itself.
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://bucket.example.com/presigned?sig=abc'),
}));

describe('StorageService', () => {
  let service: StorageService;
  let config: ConfigService;

  beforeEach(async () => {
    sendMock.mockReset().mockResolvedValue({});

    const moduleRef = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const values: Record<string, string> = {
                AWS_S3_BUCKET: 'agriconnect-test-bucket',
                AWS_REGION: 'auto',
                AWS_S3_ENDPOINT: 'https://storage.example.railway.app',
                AWS_ACCESS_KEY_ID: 'test-key',
                AWS_SECRET_ACCESS_KEY: 'test-secret',
              };
              return values[key];
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(StorageService);
    config = moduleRef.get(ConfigService);
  });

  it('uses the configured bucket name', () => {
    expect(service.bucket).toBe('agriconnect-test-bucket');
  });

  describe('isBucketKey', () => {
    // This is the load-bearing discriminator that lets read paths tell
    // "new, bucket-backed" media apart from "legacy, pre-Milestone-4"
    // rows without a schema migration — see media-url.util.ts.
    it('treats a folder-prefixed key as a bucket key', () => {
      expect(service.isBucketKey('kyc/kyc-123-456.jpg')).toBe(true);
      expect(service.isBucketKey('listings/listing-1-2.png')).toBe(true);
    });

    it('treats a bare legacy filename as NOT a bucket key', () => {
      expect(service.isBucketKey('cnicFront-1699999999-123456789.jpg')).toBe(false);
    });

    it('treats null/undefined as not a bucket key', () => {
      expect(service.isBucketKey(null)).toBe(false);
      expect(service.isBucketKey(undefined)).toBe(false);
      expect(service.isBucketKey('')).toBe(false);
    });
  });

  describe('putObject', () => {
    it('sends a PutObjectCommand for the given key/body/contentType', async () => {
      await service.putObject('kyc/kyc-1.jpg', Buffer.from('fake-bytes'), 'image/jpeg');
      expect(sendMock).toHaveBeenCalledTimes(1);
      const command = sendMock.mock.calls[0][0];
      expect(command.input).toMatchObject({
        Bucket: 'agriconnect-test-bucket',
        Key: 'kyc/kyc-1.jpg',
        ContentType: 'image/jpeg',
      });
    });
  });

  describe('deleteObject', () => {
    it('sends a DeleteObjectCommand for the given key', async () => {
      await service.deleteObject('listings/listing-1.jpg');
      expect(sendMock).toHaveBeenCalledTimes(1);
      const command = sendMock.mock.calls[0][0];
      expect(command.input).toMatchObject({
        Bucket: 'agriconnect-test-bucket',
        Key: 'listings/listing-1.jpg',
      });
    });

    // Deleting a media row should never fail just because the
    // underlying bucket object was already gone / a transient bucket
    // error occurred — see media.service.ts's remove().
    it('swallows errors rather than throwing', async () => {
      sendMock.mockRejectedValueOnce(new Error('NoSuchKey'));
      await expect(service.deleteObject('listings/already-gone.jpg')).resolves.toBeUndefined();
    });
  });

  describe('getPresignedUrl', () => {
    it('returns a presigned URL for the given key', async () => {
      const url = await service.getPresignedUrl('kyc/kyc-1.jpg', 60);
      expect(url).toBe('https://bucket.example.com/presigned?sig=abc');
    });

    it('defaults to a 300 second expiry when not specified', async () => {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      await service.getPresignedUrl('kyc/kyc-1.jpg');
      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 300 },
      );
    });
  });
});
