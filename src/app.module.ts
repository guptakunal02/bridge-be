import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module';
import { AutomationsModule } from './automations/automations.module';
import { BotModule } from './bot/bot.module';
import { ChannelsModule } from './channels/channels.module';
import { HttpModule } from './common/http/http.module';
import { LoggerModule } from './common/logger/logger.module';
import { StorageModule } from './common/storage/storage.module';
import { ThrottlerModule } from './common/throttler/throttler.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { EmailInboxModule } from './email-inbox/email-inbox.module';
import { HealthModule } from './health/health.module';
import { OutreachModule } from './outreach/outreach.module';
import { RulesModule } from './rules/rules.module';
import { SettingsModule } from './settings/settings.module';
import { TagsModule } from './tags/tags.module';
import { TeamsModule } from './teams/teams.module';
import { TicketsModule } from './tickets/tickets.module';
import { UsersModule } from './users/users.module';
import { ClickpostWebhooksModule } from './clickpost-webhooks/clickpost-webhooks.module';
import { ReturnPrimeWebhooksModule } from './return-prime-webhooks/return-prime-webhooks.module';
import { ShopifyWebhooksModule } from './shopify-webhooks/shopify-webhooks.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WhatsappInboxModule } from './whatsapp-inbox/whatsapp-inbox.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule,
    HttpModule,
    StorageModule,
    ThrottlerModule,
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 20 }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ChannelsModule,
    EmailInboxModule,
    TicketsModule,
    TeamsModule,
    RulesModule,
    SettingsModule,
    TagsModule,
    BotModule,
    AutomationsModule,
    WhatsappInboxModule,
    WebhooksModule,
    ShopifyWebhooksModule,
    ReturnPrimeWebhooksModule,
    ClickpostWebhooksModule,
    OutreachModule,
  ],
})
export class AppModule {}
