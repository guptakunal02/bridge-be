import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { ClickpostWebhooksController } from './clickpost-webhooks.controller';
import { ClickpostWebhooksService } from './clickpost-webhooks.service';
import { ClickpostWebhookEvent } from './entities/clickpost-webhook-event.entity';
import { ClickpostApiKeyGuard } from './guards/clickpost-api-key.guard';

/**
 * Receive-only module for Clickpost tracking webhooks. Dispatches
 * normalised status events through the AutomationEngine so admins can
 * trigger WhatsApp templates on clickpost.order_delivered /
 * clickpost.return_delivered without caring about Clickpost's wildly
 * inconsistent raw status strings.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ClickpostWebhookEvent]),
    // forwardRef — AutomationEngine's handler dispatcher resolves
    // template-send actions through the whatsapp-inbox module which
    // may in future import clickpost context. Belt + braces.
    forwardRef(() => AutomationsModule),
  ],
  controllers: [ClickpostWebhooksController],
  providers: [ClickpostWebhooksService, ClickpostApiKeyGuard],
  exports: [ClickpostWebhooksService],
})
export class ClickpostWebhooksModule {}
