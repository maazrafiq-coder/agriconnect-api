import { StorageEngine } from 'multer';
import { ConfigService } from '@nestjs/config';
import { extname } from 'path';
import { fromBuffer } from 'file-type';
import { buildS3Client } from './storage.service';
import { PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Round 2, Milestone 4.
//
// Replaces `multer.diskStorage()` across every upload path (KYC docs,
// clarification attachments, product media, listing media). Buffers the
// incoming file in memory (uploads are capped at 10MB — see `limits`
// wherever this is registered — so this is cheap) and uploads it
// straight to the bucket, never touching local disk.
//
// The generated `filename` is `<folder>/<prefix>-<unique><ext>` — i.e.
// it already includes the folder prefix — so it can be stored verbatim
// as `s3Key` in the DB exactly the way the old disk-based code stored
// the bare on-disk filename as `s3Key`. Downstream service code that
// reads `file.filename` needs no changes.
//
// Content-type validation (real magic-byte signature, not just the
// claimed extension/mimetype — closes the "malware.exe renamed to
// malware.pdf" gap) now happens HERE, on the buffered bytes, before
// anything is uploaded — strictly better than the old
// FileValidationInterceptor, which ran *after* multer had already
// written the file to disk and had to delete it again on failure. A bad
// file here is simply never persisted anywhere.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export interface S3MulterStorageOptions {
  // Bucket folder this storage instance writes into, e.g. "kyc",
  // "clarifications", "products", "listings". Kept separate per upload
  // path (rather than one big flat bucket) purely for readability when
  // browsing the bucket directly — access control is identical either
  // way since it's enforced at the application layer, not by bucket
  // path.
  folder: string;
  // Prefix for the generated filename itself, e.g. "kyc", "clarification",
  // "product", "listing" — mirrors the naming each upload path already
  // used under disk storage.
  filenamePrefix: string;
}

class S3MulterStorage implements StorageEngine {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    config: ConfigService,
    private readonly opts: S3MulterStorageOptions,
  ) {
    this.client = buildS3Client(config);
    this.bucket = config.get<string>('AWS_S3_BUCKET') || 'agriconnect-uploads';
  }

  _handleFile(
    req: any,
    file: Express.Multer.File,
    cb: (error?: any, info?: Partial<Express.Multer.File>) => void,
  ) {
    const chunks: Buffer[] = [];
    file.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    file.stream.on('error', cb);
    file.stream.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);

        const detected = await fromBuffer(buffer);
        if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
          cb(
            new Error(
              `File "${file.originalname}" failed content verification. Only genuine JPG, PNG, and PDF files are accepted.`,
            ),
          );
          return;
        }

        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const generatedName = `${this.opts.filenamePrefix}-${unique}${extname(file.originalname)}`;
        const key = `${this.opts.folder}/${generatedName}`;

        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentType: detected.mime,
          }),
        );

        cb(null, {
          // Deliberately the full bucket key (folder included) — see
          // file header comment. Existing service code reads this as
          // `file.filename` and stores it directly as `s3Key`.
          filename: key,
          size: buffer.length,
        });
      } catch (err) {
        cb(err);
      }
    });
  }

  _removeFile(req: any, file: Express.Multer.File, cb: (error: Error | null) => void) {
    // Used by multer internally to clean up if a later file in the same
    // request fails validation. Fire-and-forget is fine here — an
    // orphaned object left behind on a rare mid-request failure is a
    // minor storage cost, not a correctness issue.
    const key = (file as any).filename;
    if (!key) {
      cb(null);
      return;
    }
    this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .then(() => cb(null))
      .catch(() => cb(null));
  }
}

export function s3MulterStorage(config: ConfigService, opts: S3MulterStorageOptions): StorageEngine {
  return new S3MulterStorage(config, opts);
}
