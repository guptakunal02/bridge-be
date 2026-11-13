import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { SettingsModule } from '../settings/settings.module';
import { RewindWebhookEvent } from './entities/rewind-webhook-event.entity';
import { RewindSecretGuard } from './guards/rewind-secret.guard';
import { RewindWebhooksController } from './rewind-webhooks.controller';
import { RewindWebhooksService } from './rewind-webhooks.service';

/**
 * Receive-only module for Rewind (loyalty / rewards platform) webhooks.
 * Mirrors the shopify / clickpost / return-prime pattern: a dedicated
 * audit table, a secret-header guard, a controller that only POSTs 202,
 * and a service that persists + emits a typed automation event.
 *
 * SettingsModule is imported for AppSettingsService — the guard checks
 * the same `X-Bridge-Secret` the generic /webhooks/custom-events uses.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RewindWebhookEvent]),
    // SettingsModule itself imports RewindWebhooksModule (for the
    // Integrations controller's topicStats dispatcher), so both sides
    // of the cycle need forwardRef — otherwise one evaluates to
    // undefined at module-scan time and the whole app fails to boot.
    forwardRef(() => SettingsModule),
    forwardRef(() => AutomationsModule),
  ],
  controllers: [RewindWebhooksController],
  providers: [RewindWebhooksService, RewindSecretGuard],
  exports: [RewindWebhooksService],
})
export class RewindWebhooksModule {}
