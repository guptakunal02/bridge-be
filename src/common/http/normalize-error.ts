import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorPayload } from './envelope.types';

export interface NormalizedError {
  statusCode: number;
  payload: ErrorPayload;
}

/** Fold every possible thrown value into a stable ErrorPayload + status. */
export function normalizeError(exception: unknown): NormalizedError {
  if (exception instanceof HttpException) {
    return normalizeHttpException(exception);
  }
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    payload: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    },
  };
}

function normalizeHttpException(exception: HttpException): NormalizedError {
  const statusCode = exception.getStatus();
  const body = exception.getResponse();

  if (typeof body === 'string') {
    return {
      statusCode,
      payload: { code: toCode(exception.name), message: body },
    };
  }

  const shaped = body as {
    message?: string | string[];
    error?: string;
    details?: unknown;
  };
  const message = coerceMessage(shaped.message, exception.message);
  const code = toCode(shaped.error ?? exception.name);
  const details = Array.isArray(shaped.message) ? shaped.message : shaped.details;

  return {
    statusCode,
    payload: details === undefined ? { code, message } : { code, message, details },
  };
}

function coerceMessage(raw: unknown, fallback: string): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.join('; ');
  return fallback;
}

/** `NotFoundException` → `NOT_FOUND`, `Bad Request` → `BAD_REQUEST`. */
function toCode(input: string): string {
  return input
    .replace(/Exception$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/\s+/g, '_')
    .toUpperCase();
}
