import { Module } from '@nestjs/common';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

/**
 * V1 of the WhatsApp inbox integration — webhook endpoint only.
 *
 * Follow-up modules (not yet shipped):
 *   * schema + migration for whatsapp-side channel + message rows
 *   * ingest service: payload → ticket mint (parallel to email-inbox)
 *   * outbound send service: ticket reply → Meta Graph API
 *   * template-message support for 24h+ out-of-window outreach
 *
 * Keeping those as separate PRs so each one has its own observability
 * window before the next layer piles on.
 */
@Module({
  controllers: [WhatsappWebhookController],
  providers: [WhatsappWebhookService],
  exports: [],
})
export class WhatsappInboxModule {}
