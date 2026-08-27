import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { buildFailure } from './build-envelope';
import type { FailureEnvelope } from './envelope.types';
import { normalizeError } from './normalize-error';

/**
 * Global exception filter. Converts anything thrown out of a controller
 * (or up the guard/interceptor pipeline) into a FailureEnvelope with the
 * same shape as the success responses produced by ResponseEnvelopeInterceptor.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(HttpExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const { statusCode, payload } = normalizeError(exception);
    const envelope = buildFailure(payload, statusCode, req);

    this.record(exception, envelope);

    // A guard/interceptor may have already redirected — don't try to write again.
    if (res.headersSent) return;
    res.status(statusCode).json(envelope);
  }

  private record(exception: unknown, envelope: FailureEnvelope): void {
    const meta = {
      statusCode: envelope.statusCode,
      requestId: envelope.requestId,
      path: envelope.path,
    };
    if (envelope.statusCode >= 500) {
      this.logger.error({ ...meta, err: exception }, 'Unhandled exception');
    } else {
      this.logger.debug(meta, envelope.error.message);
    }
  }
}
