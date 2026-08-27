import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { buildSuccess } from './build-envelope';

/**
 * Wraps every successful handler return value in a SuccessEnvelope.
 * Passes through unchanged when the response has already been committed
 * (redirects) or is explicitly empty (204 No Content) — those shouldn't
 * carry a JSON body.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    return next.handle().pipe(
      map((data: unknown) => {
        if (res.headersSent) return data;
        if (res.statusCode === HttpStatus.NO_CONTENT) return data;
        return buildSuccess(data ?? null, req);
      }),
    );
  }
}
