import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnPrimeWebhookEvent } from './entities/return-prime-webhook-event.entity';
import { ReturnPrimeWebhooksController } from './return-prime-webhooks.controller';
import { ReturnPrimeWebhooksService } from './return-prime-webhooks.service';

/**
 * Receive-only module for Return Prime webhooks. Persistence +
 * Integrations UI surface today; automation emission + field
 * extraction will land once we see real payload shapes in the
 * Events inspector.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ReturnPrimeWebhookEvent])],
  controllers: [ReturnPrimeWebhooksController],
  providers: [ReturnPrimeWebhooksService],
  exports: [ReturnPrimeWebhooksService],
})
export class ReturnPrimeWebhooksModule {}
