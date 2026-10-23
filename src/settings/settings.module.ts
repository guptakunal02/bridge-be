import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopifyWebhooksModule } from '../shopify-webhooks/shopify-webhooks.module';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from './entities/app-setting.entity';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppSetting]),
    // Pulled in so the Integrations endpoint can call
    // ShopifyWebhooksService.lastEventAt. forwardRef in case a future
    // ShopifyWebhooksModule change imports back into SettingsModule.
    forwardRef(() => ShopifyWebhooksModule),
  ],
  controllers: [SettingsController],
  providers: [AppSettingsService],
  // AppSettingsService exported so the email-inbox ingest path can
  // read the resolved-reopen window on each incoming message.
  exports: [AppSettingsService],
})
export class SettingsModule {}
