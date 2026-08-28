import { PassThrough } from 'stream';
import { ConfigService } from '@nestjs/config';
import { s3MulterStorage } from './s3-multer-storage';

// Round 2, Milestone 4.
//
// This is the security-critical piece of the storage migration: content
// (magic-byte) validation now happens here, on the buffered file, BEFORE
// anything is uploaded to the bucket — replacing the old
// FileValidationInterceptor, which ran only after multer had already
// written the file to local disk. A bad file should never reach
// PutObjectCommand at all.
const sendMock = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  };
});

// Minimal real magic-byte signatures — enough for `file-type` to detect
// the actual format, not just trust the claimed mimetype/extension.
// Padded with trailing zero bytes since file-type's buffer-based
// detector needs a minimum amount of data to read past the header for
// some formats (a real upload is always far larger than this).
const pad = (bytes: number[]) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);
const REAL_JPEG_BYTES = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const REAL_PNG_BYTES = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_EXE_RENAMED_AS_JPG = pad([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // "MZ..." — a Windows PE header

function makeFile(originalname: string, bytes: Buffer): any {
  const stream = new PassThrough();
  const file = { originalname, stream };
  process.nextTick(() => {
    stream.emit('data', bytes);
    stream.emit('end');
  });
  return file;
}

const config = {
  get: jest.fn((key: string) => {
    const values: Record<string, string> = { AWS_S3_BUCKET: 'agriconnect-test-bucket' };
    return values[key];
  }),
} as unknown as ConfigService;

describe('s3MulterStorage', () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({});
  });

  it('uploads a genuine JPEG and returns a folder-prefixed filename', (done) => {
    const engine = s3MulterStorage(config, { folder: 'kyc', filenamePrefix: 'kyc' });
    const file = makeFile('cnic-front.jpg', REAL_JPEG_BYTES);

    (engine as any)._handleFile({}, file, (err: any, info: any) => {
      expect(err).toBeFalsy();
      expect(info.filename).toMatch(/^kyc\/kyc-\d+-\d+\.jpg$/);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const command = sendMock.mock.calls[0][0];
      expect(command.input.Bucket).toBe('agriconnect-test-bucket');
      expect(command.input.Key).toBe(info.filename);
      expect(command.input.ContentType).toBe('image/jpeg');
      done();
    });
  });

  it('uploads a genuine PNG under the listings folder', (done) => {
    const engine = s3MulterStorage(config, { folder: 'listings', filenamePrefix: 'listing' });
    const file = makeFile('photo.png', REAL_PNG_BYTES);

    (engine as any)._handleFile({}, file, (err: any, info: any) => {
      expect(err).toBeFalsy();
      expect(info.filename).toMatch(/^listings\/listing-\d+-\d+\.png$/);
      done();
    });
  });

  it('rejects a file whose real content does not match an allowed type, and never uploads it', (done) => {
    const engine = s3MulterStorage(config, { folder: 'kyc', filenamePrefix: 'kyc' });
    // Claims to be a .jpg by extension but is actually a Windows executable.
    const file = makeFile('totally-a-photo.jpg', FAKE_EXE_RENAMED_AS_JPG);

    (engine as any)._handleFile({}, file, (err: any) => {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('failed content verification');
      // The critical assertion: nothing was ever persisted to the bucket.
      expect(sendMock).not.toHaveBeenCalled();
      done();
    });
  });

  it('rejects an unrecognizable/empty file without uploading it', (done) => {
    const engine = s3MulterStorage(config, { folder: 'clarifications', filenamePrefix: 'clarification' });
    const file = makeFile('empty.jpg', Buffer.from([]));

    (engine as any)._handleFile({}, file, (err: any) => {
      expect(err).toBeInstanceOf(Error);
      expect(sendMock).not.toHaveBeenCalled();
      done();
    });
  });

  it('_removeFile best-effort deletes the uploaded object', (done) => {
    const engine = s3MulterStorage(config, { folder: 'products', filenamePrefix: 'product' });
    const file = { filename: 'products/product-123.jpg' } as any;

    (engine as any)._removeFile({}, file, (err: any) => {
      expect(err).toBeNull();
      expect(sendMock).toHaveBeenCalledTimes(1);
      const command = sendMock.mock.calls[0][0];
      expect(command.input).toMatchObject({ Bucket: 'agriconnect-test-bucket', Key: 'products/product-123.jpg' });
      done();
    });
  });
});
