import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { EnvVars } from '../../config/env.validation';

/**
 * Verifies the `X-Api-Key` header on inbound Clickpost webhooks.
 * Clickpost's dashboard lets the admin paste a fixed key value;
 * every webhook they fire stamps that key verbatim. Constant-time
 * compare against our env var.
 *
 * 503 when the env var is unset (configured on Bridge side ≠
 * configured on Clickpost side), 403 on mismatch. Distinct statuses
 * so a quick log glance tells "not wired up" from "someone's forging
 * requests" apart.
 */
@Injectable()
export class ClickpostApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ClickpostApiKeyGuard.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get('CLICKPOST_WEBHOOK_API_KEY', {
      infer: true,
    });
    if (!expected) {
      this.logger.warn(
        'Clickpost guard: CLICKPOST_WEBHOOK_API_KEY unset — rejecting with 503',
      );
      throw new ServiceUnavailableException(
        'Clickpost integration not configured',
      );
    }
    const req = context.switchToHttp().getRequest<Request>();
    const received = (req.get('x-api-key') ?? '').trim();
    if (!received) {
      this.logger.warn('Clickpost guard rejected: missing X-Api-Key header');
      throw new ForbiddenException('API key required');
    }

    const receivedBuf = Buffer.from(received, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (receivedBuf.length !== expectedBuf.length) {
      this.logger.warn('Clickpost guard rejected: API key length mismatch');
      throw new ForbiddenException('API key mismatch');
    }
    if (!timingSafeEqual(receivedBuf, expectedBuf)) {
      this.logger.warn('Clickpost guard rejected: API key mismatch');
      throw new ForbiddenException('API key mismatch');
    }
    return true;
  }
}
