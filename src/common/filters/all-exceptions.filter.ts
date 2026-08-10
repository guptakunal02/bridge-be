import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { REQUEST_ID_HEADER } from '../logger/logger.module';

export interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId: string | null;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, error, message } = this.normalize(exception);

    const requestId = this.readRequestId(request);
    const envelope: ErrorEnvelope = {
      statusCode,
      error,
      message,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
    };

    if (statusCode >= 500) {
      this.logger.error(
        {
          err: exception,
          req: { id: requestId, method: request.method, url: envelope.path },
        },
        'Unhandled exception',
      );
    } else {
      this.logger.debug(
        { statusCode, path: envelope.path, requestId },
        typeof message === 'string' ? message : message.join('; '),
      );
    }

    response.status(statusCode).json(envelope);
  }

  private normalize(exception: unknown): {
    statusCode: number;
    error: string;
    message: string | string[];
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        return { statusCode: status, error: exception.name, message: res };
      }

      const body = res as { message?: string | string[]; error?: string };
      return {
        statusCode: status,
        error: body.error ?? exception.name,
        message: body.message ?? exception.message,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'Internal server error',
    };
  }

  private readRequestId(request: Request): string | null {
    const fromReq = (request as unknown as { id?: string }).id;
    if (typeof fromReq === 'string' && fromReq.length > 0) {
      return fromReq;
    }
    const header = request.headers[REQUEST_ID_HEADER];
    return typeof header === 'string' ? header : null;
  }
}
