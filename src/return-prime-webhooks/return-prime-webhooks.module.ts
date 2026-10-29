import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { ReturnPrimeWebhookEvent } from './entities/return-prime-webhook-event.entity';
import { LensForwardSecretGuard } from './guards/lens-forward-secret.guard';
import { ReturnPrimeWebhooksController } from './return-prime-webhooks.controller';
import { ReturnPrimeWebhooksService } from './return-prime-webhooks.service';

/**
 * Return Prime webhook receiver. forwardRef on AutomationsModule for
 * the same reason LensWebhooksModule needs it: both modules get
 * reached through the SettingsModule chain after AutomationsModule is
 * already deep in the resolution graph (BotModule → WhatsappInboxModule
 * → EmailInboxModule → AutomationsModule). Without the forwardRef one
 * of the two entries resolves to undefined and bootstrap aborts with
 * UndefinedModuleException.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ReturnPrimeWebhookEvent]),
    forwardRef(() => AutomationsModule),
  ],
  controllers: [ReturnPrimeWebhooksController],
  providers: [ReturnPrimeWebhooksService, LensForwardSecretGuard],
  exports: [ReturnPrimeWebhooksService],
})
export class ReturnPrimeWebhooksModule {}
