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
      // Prisma's generated typings may expose code/meta differently
      // depending on the installed Prisma version. Safely narrow the
      // properties before accessing them.
      const prismaException = exception as Prisma.PrismaClientKnownRequestError & {
        code: string;
        meta?: {
          target?: string[] | string;
        };
      };

      switch (prismaException.code) {
        case 'P2002': {
          status = HttpStatus.CONFLICT;

          const target = prismaException.meta?.target;

          const targetMessage = Array.isArray(target)
            ? target.join(', ')
            : target || 'value';

          message = `A record with this ${targetMessage} already exists`;
          break;
        }

        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          message = 'Record not found';
          break;

        case 'P2021':
        case 'P2022':
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          message =
            "Database schema is out of date. Run `npx prisma db push` against this environment's database.";
          break;

        default:
          message = `Database error (${prismaException.code})`;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message =
        'Database client is out of sync with the schema. The server needs to redeploy with a fresh prisma generate.';
    }

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error: typeof message === 'string' ? { message } : message,
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(errorResponse);
  }
}
