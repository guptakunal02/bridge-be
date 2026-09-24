import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module';
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
import { RulesModule } from './rules/rules.module';
import { SettingsModule } from './settings/settings.module';
import { TagsModule } from './tags/tags.module';
import { TeamsModule } from './teams/teams.module';
import { TicketsModule } from './tickets/tickets.module';
import { UsersModule } from './users/users.module';

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
  ],
})
export class AppModule {}
