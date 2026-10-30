import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClickpostWebhooksModule } from '../clickpost-webhooks/clickpost-webhooks.module';
import { LensWebhooksModule } from '../lens-webhooks/lens-webhooks.module';
import { ReturnPrimeWebhooksModule } from '../return-prime-webhooks/return-prime-webhooks.module';
import { ShopifyWebhooksModule } from '../shopify-webhooks/shopify-webhooks.module';
import { WhatsappMessage } from '../whatsapp-inbox/entities/whatsapp-message.entity';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from './entities/app-setting.entity';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    // WhatsappMessage repo is read-only here — the Integrations page
    // uses MAX(createdAt) as a stand-in for "last WhatsApp activity"
    // since Bridge doesn't audit Meta webhooks to a dedicated table.
    TypeOrmModule.forFeature([AppSetting, WhatsappMessage]),
    // forwardRef in case a platform module ever imports back into
    // SettingsModule down the line — belt + braces.
    forwardRef(() => ShopifyWebhooksModule),
    forwardRef(() => ReturnPrimeWebhooksModule),
    forwardRef(() => ClickpostWebhooksModule),
    forwardRef(() => LensWebhooksModule),
  ],
  controllers: [SettingsController],
  providers: [AppSettingsService],
  // AppSettingsService exported so the email-inbox ingest path can
  // read the resolved-reopen window on each incoming message.
  exports: [AppSettingsService],
})
export class SettingsModule {}
