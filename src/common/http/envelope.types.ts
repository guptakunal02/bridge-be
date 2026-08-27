// Shared response envelope shared by success and failure paths. Every
// controller return value is wrapped by ResponseEnvelopeInterceptor;
// every thrown exception is normalized by HttpExceptionFilter.

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  requestId: string | null;
  timestamp: string;
}

export interface ErrorPayload {
  /** Stable machine-readable code, e.g. `UNAUTHORIZED`, `VALIDATION_FAILED`. */
  code: string;
  /** Human-readable single-line message safe to show to end users. */
  message: string;
  /** Optional structured extras (field errors, retry hints, etc.). */
  details?: unknown;
}

export interface FailureEnvelope {
  ok: false;
  error: ErrorPayload;
  statusCode: number;
  requestId: string | null;
  timestamp: string;
  path: string;
}

export type ApiEnvelope<T = unknown> = SuccessEnvelope<T> | FailureEnvelope;
