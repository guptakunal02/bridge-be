import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AssignmentModule } from './assignment/assignment.module';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { HttpModule } from './common/http/http.module';
import { LoggerModule } from './common/logger/logger.module';
import { ThrottlerModule } from './common/throttler/throttler.module';
import { validateEnv } from './config/env.validation';
import { ContactsModule } from './contacts/contacts.module';
import { ConversationsModule } from './conversations/conversations.module';
import { EmailInboxModule } from './email-inbox/email-inbox.module';
import { HealthModule } from './health/health.module';
import { PresenceModule } from './presence/presence.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule,
    HttpModule,
    ThrottlerModule,
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 20 }),
    PrismaModule,
    PresenceModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ChannelsModule,
    ContactsModule,
    ConversationsModule,
    AssignmentModule,
    RealtimeModule,
    WebhooksModule,
    EmailInboxModule,
  ],
})
export class AppModule {}
