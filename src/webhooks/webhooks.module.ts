import { forwardRef, Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { SettingsModule } from '../settings/settings.module';
import { WebhooksController } from './webhooks.controller';

/**
 * External webhook surface. Exposes POST /webhooks/custom-events —
 * authenticated by the stored webhook secret header, dispatches a
 * WEBHOOK_CUSTOM automation event. Depends on:
 *   * SettingsModule   — reads the shared secret
 *   * AutomationsModule — emits the event; forwardRef because the
 *                        automations module graph is heavy
 */
@Module({
  imports: [SettingsModule, forwardRef(() => AutomationsModule)],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
