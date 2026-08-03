import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | object = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.getResponse();
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Common, diagnosable database errors — surface a real message
      // instead of a bare "Internal server error" that gives no clue
      // whether it's a bad request or a missing migration.
      switch (exception.code) {
        case 'P2002':
          status = HttpStatus.CONFLICT;
          message = `A record with this ${(exception.meta?.target as string[])?.join(', ') || 'value'} already exists`;
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          message = 'Record not found';
          break;
        case 'P2021':
        case 'P2022':
          // Table or column genuinely doesn't exist in the database — this
          // means a schema migration (`prisma db push`) hasn't been run
          // against this environment's database yet.
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          message = 'Database schema is out of date. Run `npx prisma db push` against this environment\'s database.';
          break;
        default:
          message = `Database error (${exception.code})`;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      // Thrown when code calls a Prisma model/field that doesn't exist on
      // the currently-generated client — the exact symptom of a stale
      // Prisma Client that predates a schema change (fixed by ensuring
      // `postinstall: prisma generate` runs on every deploy).
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Database client is out of sync with the schema. The server needs to redeploy with a fresh `prisma generate`.';
    }

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error: typeof message === 'string' ? { message } : message,
    };

    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url}`, exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(status).json(errorResponse);
  }
}
