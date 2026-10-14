import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { EnvVars } from '../../config/env.validation';

/**
 * Verifies the X-Hub-Signature-256 header on inbound WhatsApp webhook
 * POSTs. Meta signs the raw request body with APP_SECRET using
 * HMAC-SHA256; a signature mismatch means someone else is forging a
 * payload at our public URL, so we 403.
 *
 * Pre-reqs:
 *   * main.ts must install the express.json verify callback that
 *     stashes the raw body on req.rawBody — the parsed JSON can
 *     re-serialise differently from the bytes Meta signed.
 *   * WHATSAPP_APP_SECRET must be set (env validation enforces).
 *
 * Only applied to POST (inbound delivery). The GET verify handshake
 * doesn't send a body and uses the hub.verify_token mechanism
 * instead.
 */
@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    if (!req.rawBody || req.rawBody.length === 0) {
      this.logger.warn(
        'Signature guard rejected: raw body missing (main.ts verify hook not wired?)',
      );
      throw new ForbiddenException('Signature verification unavailable');
    }

    const header = req.get('x-hub-signature-256') ?? '';
    if (!header.startsWith('sha256=')) {
      this.logger.warn(
        'Signature guard rejected: no X-Hub-Signature-256 header or wrong prefix',
      );
      throw new ForbiddenException('Signature required');
    }

    const received = header.slice('sha256='.length);
    const secret = this.config.get('WHATSAPP_APP_SECRET', { infer: true });
    const expected = createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    // Length-safe timing-safe compare. Different lengths → bail before
    // timingSafeEqual (which throws on mismatched lengths).
    if (received.length !== expected.length) {
      this.logger.warn('Signature guard rejected: signature length mismatch');
      throw new ForbiddenException('Signature mismatch');
    }
    const match = timingSafeEqual(
      Buffer.from(received, 'hex'),
      Buffer.from(expected, 'hex'),
    );
    if (!match) {
      this.logger.warn('Signature guard rejected: HMAC mismatch');
      throw new ForbiddenException('Signature mismatch');
    }
    return true;
  }
}
