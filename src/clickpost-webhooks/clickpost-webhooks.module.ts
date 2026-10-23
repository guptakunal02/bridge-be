import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClickpostWebhooksController } from './clickpost-webhooks.controller';
import { ClickpostWebhooksService } from './clickpost-webhooks.service';
import { ClickpostWebhookEvent } from './entities/clickpost-webhook-event.entity';
import { ClickpostApiKeyGuard } from './guards/clickpost-api-key.guard';

/**
 * Receive-only module for Clickpost tracking webhooks. Automation
 * emission + field extraction will land in a follow-up commit after
 * we observe real OFD / Delivered payloads in the Events inspector.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ClickpostWebhookEvent])],
  controllers: [ClickpostWebhooksController],
  providers: [ClickpostWebhooksService, ClickpostApiKeyGuard],
  exports: [ClickpostWebhooksService],
})
export class ClickpostWebhooksModule {}
