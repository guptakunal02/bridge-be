import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppSettingsService } from '../../settings/app-settings.service';

/**
 * Verifies the `X-Bridge-Secret` header on inbound Rewind webhooks.
 * Reuses the same admin-rotatable token the generic
 * /webhooks/custom-events endpoint checks — one secret, one rotation
 * surface. Admin pastes the value from the Bridge settings page into
 * Rewind's webhook config; Rewind stamps every outbound call with it.
 *
 * No separate env var: the secret lives in `app_setting.webhook_secret`
 * and auto-generates on first read, so dev + prod both boot cleanly
 * without extra setup. Rotating via the existing
 * /settings/webhook-secret/rotate admin endpoint invalidates the token
 * for BOTH Rewind and custom-events — same trust boundary, which is
 * the right default.
 */
@Injectable()
export class RewindSecretGuard implements CanActivate {
  private readonly logger = new Logger(RewindSecretGuard.name);

  constructor(private readonly settings: AppSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const received = (req.get('x-bridge-secret') ?? '').trim();
    if (!received) {
      this.logger.warn(
        'Rewind guard rejected: missing X-Bridge-Secret header',
      );
      throw new UnauthorizedException('Invalid X-Bridge-Secret header');
    }
    const expected = await this.settings.getWebhookSecret();
    const receivedBuf = Buffer.from(received, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      receivedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      this.logger.warn('Rewind guard rejected: secret mismatch');
      throw new UnauthorizedException('Invalid X-Bridge-Secret header');
    }
    return true;
  }
}
