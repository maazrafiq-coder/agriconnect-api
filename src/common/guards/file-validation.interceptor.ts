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
    const files: Express.Multer.File[] = request.files
      ? request.files
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
