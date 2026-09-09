import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { HttpModule } from './common/http/http.module';
import { LoggerModule } from './common/logger/logger.module';
import { ThrottlerModule } from './common/throttler/throttler.module';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
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
    ThrottlerModule,
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 20 }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ChannelsModule,
  ],
})
export class AppModule {}
