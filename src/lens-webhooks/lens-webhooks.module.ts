import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { ReturnPrimeWebhooksModule } from '../return-prime-webhooks/return-prime-webhooks.module';
import { LensWebhookEvent } from './entities/lens-webhook-event.entity';
import { LensWebhooksController } from './lens-webhooks.controller';
import { LensWebhooksService } from './lens-webhooks.service';

/**
 * Lens-forward receiver (NDR / NPR). Imports ReturnPrimeWebhooksModule
 * to reuse LensForwardSecretGuard (shared across both Lens-fed
 * endpoints: /webhooks/return-prime for RP, /webhooks/lens for
 * delivery exceptions).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LensWebhookEvent]),
    AutomationsModule,
    ReturnPrimeWebhooksModule,
  ],
  controllers: [LensWebhooksController],
  providers: [LensWebhooksService],
  exports: [LensWebhooksService],
})
export class LensWebhooksModule {}
