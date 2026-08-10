import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModule as NestThrottlerModule,
} from '@nestjs/throttler';

@Module({
  imports: [
    NestThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class ThrottlerModule {}

// Per-route tight limits. Use with @Throttle(...) on the sensitive endpoints.
export const AUTH_LOGIN_THROTTLE = {
  default: { ttl: 60_000, limit: 5 },
} as const;
export const AUTH_REFRESH_THROTTLE = {
  default: { ttl: 60_000, limit: 30 },
} as const;
export const INVITATION_ACCEPT_THROTTLE = {
  default: { ttl: 60_000, limit: 10 },
} as const;
