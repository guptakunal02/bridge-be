import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './http-exception.filter';
import { ResponseEnvelopeInterceptor } from './response.interceptor';

/**
 * Wires the standard response envelope: success interceptor + error filter.
 * Import once at the top of AppModule; no per-controller opt-in required.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class HttpModule {}

export type { ApiEnvelope, SuccessEnvelope, FailureEnvelope, ErrorPayload } from './envelope.types';
