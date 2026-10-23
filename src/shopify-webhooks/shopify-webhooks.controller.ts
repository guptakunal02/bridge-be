import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ShopifySignatureGuard } from './guards/shopify-signature.guard';
import { ShopifyWebhooksService } from './shopify-webhooks.service';

/**
 * Single catch-all endpoint for every Shopify webhook topic. We
 * dispatch internally by `X-Shopify-Topic`; keeps the Shopify-side
 * subscription config minimal (one URL for every topic) and lets us
 * add topic handling without touching the Shopify Admin.
 *
 * Guard order matters:
 *   1. @Public() bypasses the session JWT guard — Shopify can't log in.
 *   2. ShopifySignatureGuard verifies the HMAC + shop domain. Rejects
 *      unsigned / wrong-shop requests before we parse the body.
 *
 * Response is always 200/202 for a well-signed request — Shopify
 * retries on non-2xx. Even dedup / unknown-topic / missing-fields
 * cases return 202 so Shopify stops retrying.
 */
@Public()
@Controller('webhooks/shopify')
@UseGuards(ShopifySignatureGuard)
export class ShopifyWebhooksController {
  constructor(private readonly service: ShopifyWebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Req() req: Request,
    @Headers('x-shopify-topic') topic: string | undefined,
    @Headers('x-shopify-webhook-id') webhookId: string | undefined,
    @Headers('x-shopify-shop-domain') shopDomain: string | undefined,
  ): Promise<{ accepted: true; deduped: boolean }> {
    if (!topic || !webhookId || !shopDomain) {
      // Signature guard already verified the HMAC + shop domain; a
      // missing header at this point means Shopify shipped malformed
      // metadata. 400 so retries stop (vs a 500 which Shopify treats
      // as transient and keeps retrying).
      throw new BadRequestException(
        'Missing one of X-Shopify-Topic, X-Shopify-Webhook-Id, X-Shopify-Shop-Domain',
      );
    }
    // Body is the already-parsed JSON Nest handed us; we trust the
    // HMAC guard above to have verified the raw bytes.
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const result = await this.service.handle({
      webhookId,
      topic,
      shopDomain,
      payload,
    });
    return { accepted: true, deduped: result.deduped };
  }
}
