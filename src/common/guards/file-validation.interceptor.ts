import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
  BadRequestException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { fromBuffer } from 'file-type';
import * as fs from 'fs/promises';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

/**
 * @deprecated Round 2, Milestone 4 — every upload path now goes through
 * the shared S3-backed multer storage engine
 * (common/storage/s3-multer-storage.ts), which does this exact
 * magic-byte content check on the buffered file *before* it's ever
 * uploaded to the bucket. That's strictly better than this
 * interceptor's old approach of checking `file.path` on local disk
 * *after* multer had already written it there — a bad file here would
 * have to be deleted again on failure; the new approach simply never
 * persists it in the first place.
 *
 * Kept in the repo (unused) rather than deleted, in case anything ever
 * needs a standalone re-check of already-uploaded bytes.
 *
 * Runs AFTER multer has already written the file to disk (diskStorage).
 * Re-reads the file and checks its real magic-byte signature, not just
 * the extension multer's fileFilter already approved. Rejects and deletes
 * the file if the actual content doesn't match an allowed type.
 *
 * This closes the "malware.exe renamed to malware.pdf" gap — a filename
 * check alone can be trivially spoofed.
 */
@Injectable()
export class FileValidationInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    // FilesInterceptor (single field) gives request.files as an array.
    // FileFieldsInterceptor (named fields, e.g. cnicFront/cnicBack) gives
    // an object keyed by field name instead — flatten either shape to a
    // single list so the content check below runs uniformly.
    const raw = request.files;
    const files: Express.Multer.File[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.values(raw).flat()
        : request.file
          ? [request.file]
          : [];

    for (const file of files) {
      const buffer = await fs.readFile(file.path);
      const detected = await fromBuffer(buffer);

      // fromBuffer returns undefined for plain text — but PDFs/images always
      // have a detectable signature, so undefined here means the content
      // doesn't match what the filename/mimetype claimed.
      if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
        await fs.unlink(file.path).catch(() => {});
        throw new BadRequestException(
          `File "${file.originalname}" failed content verification. Only genuine JPG, PNG, and PDF files are accepted.`,
        );
      }
    }

    return next.handle();
  }
}
