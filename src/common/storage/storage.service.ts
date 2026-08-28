import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Round 2, Milestone 4 — persistent file storage.
//
// Railway's container filesystem is ephemeral (wiped on every redeploy),
// so `multer.diskStorage()` was silently losing every uploaded file —
// KYC documents, listing photos, clarification attachments — the moment
// the app redeployed. This service replaces local disk with Railway
// Storage Buckets, Railway's own S3-compatible object storage.
//
// Because it's S3-compatible, this is built on the standard AWS SDK v3
// S3 client rather than anything Railway-specific: the same code works
// unchanged against real AWS S3 (already-scaffolded AWS_* env vars) if
// the project ever migrates off Railway — only AWS_S3_ENDPOINT needs to
// go away.
export function buildS3Client(config: ConfigService): S3Client {
  const endpoint = config.get<string>('AWS_S3_ENDPOINT');
  return new S3Client({
    region: config.get<string>('AWS_REGION') || 'auto',
    endpoint: endpoint || undefined,
    // Path-style addressing (https://endpoint/bucket/key rather than
    // https://bucket.endpoint/key) is required by most S3-compatible
    // providers, including Railway Storage Buckets. Real AWS S3 accepts
    // it too, so this is safe to leave on even if AWS_S3_ENDPOINT is
    // later removed for a migration to real AWS.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID') || '',
      secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY') || '',
    },
  });
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(private config: ConfigService) {
    this.bucket = this.config.get<string>('AWS_S3_BUCKET') || 'agriconnect-uploads';
    this.client = buildS3Client(this.config);
  }

  async putObject(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  // Best-effort — a failed delete (e.g. object already gone) shouldn't
  // block the surrounding DB operation (removing a media row, resolving
  // a clarification) from succeeding.
  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.logger.warn(`Failed to delete storage object "${key}": ${err}`);
    }
  }

  // Short-lived, single-object, read-only signed URL. Used for both:
  //  - private files (KYC docs, clarification attachments) behind our
  //    own signed-JWT-token proxy endpoint (see resolveKycFileToken /
  //    resolveFileToken) — this presigned URL is the final hop after our
  //    own access check has already passed.
  //  - public-ish listing/product media, generated fresh on every read
  //    rather than stored statically, so it works the same whether the
  //    bucket is public or private and never goes stale.
  async getPresignedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  // Bucket keys we generate always look like "<folder>/<generated-name>"
  // (see s3-multer-storage.ts). Legacy rows created before Milestone 4
  // stored a bare filename with no folder as `s3Key` (local disk had no
  // concept of a bucket prefix). This lets read paths tell the two apart
  // without a schema migration/new column.
  isBucketKey(s3Key: string | null | undefined): s3Key is string {
    return !!s3Key && s3Key.includes('/');
  }
}
