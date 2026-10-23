import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { EnvVars } from '../../config/env.validation';

/**
 * Verifies `X-Shopify-Hmac-Sha256` (base64) + `X-Shopify-Shop-Domain`
 * on inbound Shopify webhook POSTs. Mirrors the WhatsApp signature
 * guard pattern but with Shopify's base64 digest encoding and an
 * extra domain-match check so a leaked secret from another shop
 * can't be replayed against ours.
 *
 * Returns ServiceUnavailableException (503) when the secret or shop
 * domain is unset — distinguishable from a signature mismatch (403)
 * so an admin can tell "I haven't configured Shopify yet" from
 * "someone is trying to spoof our endpoint" at a glance in the logs.
 *
 * Pre-reqs:
 *   * main.ts installs the express.json verify callback that stashes
 *     the raw body on req.rawBody — Shopify signs the exact bytes,
 *     not a re-serialised JSON.
 *   * SHOPIFY_WEBHOOK_SECRET + SHOPIFY_SHOP_DOMAIN must be set in env.
 */
@Injectable()
export class ShopifySignatureGuard implements CanActivate {
  private readonly logger = new Logger(ShopifySignatureGuard.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const secret = this.config.get('SHOPIFY_WEBHOOK_SECRET', { infer: true });
    const expectedDomain = this.config.get('SHOPIFY_SHOP_DOMAIN', {
      infer: true,
    });
    if (!secret || !expectedDomain) {
      // Not configured — fail fast with a distinct status so admin
      // can grep for it. 503 is "service unavailable" semantically
      // closer than 403 ("you're forbidden"), which is what a real
      // signature mismatch returns below.
      this.logger.warn(
        'Shopify signature guard: SHOPIFY_WEBHOOK_SECRET or SHOPIFY_SHOP_DOMAIN unset — rejecting with 503',
      );
      throw new ServiceUnavailableException('Shopify integration not configured');
    }

    if (!req.rawBody || req.rawBody.length === 0) {
      this.logger.warn(
        'Shopify signature guard rejected: raw body missing (main.ts verify hook not wired?)',
      );
      throw new ForbiddenException('Signature verification unavailable');
    }

    const receivedDomain = (req.get('x-shopify-shop-domain') ?? '').trim();
    if (receivedDomain !== expectedDomain) {
      this.logger.warn(
        `Shopify signature guard rejected: shop domain mismatch received="${receivedDomain}" expected="${expectedDomain}"`,
      );
      throw new ForbiddenException('Shop domain mismatch');
    }

    const header = (req.get('x-shopify-hmac-sha256') ?? '').trim();
    if (!header) {
      this.logger.warn(
        'Shopify signature guard rejected: no X-Shopify-Hmac-Sha256 header',
      );
      throw new ForbiddenException('Signature required');
    }

    const expected = createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('base64');

    // Length-safe compare — timingSafeEqual throws on mismatched
    // buffer lengths, so pre-check before invoking it.
    const receivedBuf = Buffer.from(header, 'base64');
    const expectedBuf = Buffer.from(expected, 'base64');
    if (receivedBuf.length !== expectedBuf.length) {
      this.logger.warn('Shopify signature guard rejected: signature length mismatch');
      throw new ForbiddenException('Signature mismatch');
    }
    const match = timingSafeEqual(receivedBuf, expectedBuf);
    if (!match) {
      this.logger.warn('Shopify signature guard rejected: HMAC mismatch');
      throw new ForbiddenException('Signature mismatch');
    }
    return true;
  }
}
