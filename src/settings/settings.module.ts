import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReturnPrimeWebhooksModule } from '../return-prime-webhooks/return-prime-webhooks.module';
import { ShopifyWebhooksModule } from '../shopify-webhooks/shopify-webhooks.module';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from './entities/app-setting.entity';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppSetting]),
    // forwardRef in case a platform module ever imports back into
    // SettingsModule down the line — belt + braces.
    forwardRef(() => ShopifyWebhooksModule),
    forwardRef(() => ReturnPrimeWebhooksModule),
  ],
  controllers: [SettingsController],
  providers: [AppSettingsService],
  // AppSettingsService exported so the email-inbox ingest path can
  // read the resolved-reopen window on each incoming message.
  exports: [AppSettingsService],
})
export class SettingsModule {}
