import type { Request } from 'express';
import { REQUEST_ID_HEADER } from '../logger/logger.module';
import type {
  ErrorPayload,
  FailureEnvelope,
  SuccessEnvelope,
} from './envelope.types';

/** Read the pino-http assigned request id, falling back to the header. */
export function readRequestId(req: Request): string | null {
  const attached = (req as unknown as { id?: string }).id;
  if (typeof attached === 'string' && attached.length > 0) return attached;
  const header = req.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' ? header : null;
}

export function buildSuccess<T>(data: T, req: Request): SuccessEnvelope<T> {
  return {
    ok: true,
    data,
    requestId: readRequestId(req),
    timestamp: new Date().toISOString(),
  };
}

export function buildFailure(
  error: ErrorPayload,
  statusCode: number,
  req: Request,
): FailureEnvelope {
  return {
    ok: false,
    error,
    statusCode,
    requestId: readRequestId(req),
    timestamp: new Date().toISOString(),
    path: req.originalUrl ?? req.url,
  };
}
