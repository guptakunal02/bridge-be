import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { ShopifyWebhookEvent } from './entities/shopify-webhook-event.entity';
import { ShopifySignatureGuard } from './guards/shopify-signature.guard';
import { ShopifyWebhooksController } from './shopify-webhooks.controller';
import { ShopifyWebhooksService } from './shopify-webhooks.service';

/**
 * Shopify-side ingress — HMAC-verified webhook endpoint, audit +
 * dedup table, dispatch into the automation engine. The service is
 * exported so the Integrations settings endpoint can read
 * `lastEventAt` without re-injecting the repository.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ShopifyWebhookEvent]),
    // forwardRef because AutomationsModule already pulls in modules
    // that may lean on this one in the future (via action handlers);
    // belt + braces against a cycle developing on either side.
    forwardRef(() => AutomationsModule),
  ],
  controllers: [ShopifyWebhooksController],
  providers: [ShopifyWebhooksService, ShopifySignatureGuard],
  exports: [ShopifyWebhooksService],
})
export class ShopifyWebhooksModule {}
