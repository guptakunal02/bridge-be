import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import { RulesModule } from '../rules/rules.module';
import { TeamsModule } from '../teams/teams.module';
import { UsersModule } from '../users/users.module';
import { EmailInboxController } from './email-inbox.controller';
import { EmailInboxService } from './email-inbox.service';
import { EmailInboxWorker } from './email-inbox.worker';
import { EmailMessage } from './entities/email-message.entity';
import { EmailMessageRepository } from './providers/email-message.repository';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmailMessage, Channel]),
    ChannelsModule,
    // AssignmentPickerService for round-robining new tickets to
    // Online agents at ingest time.
    UsersModule,
    // TeamsService — needed to resolve the default team every ingest.
    TeamsModule,
    // RoutingService — evaluates active rules on every new ticket.
    RulesModule,
    // BotRuntimeService — fires TICKET_CREATED on fresh threads and
    // advances any ACTIVE session on customer replies.
    BotModule,
  ],
  controllers: [EmailInboxController],
  providers: [EmailInboxService, EmailMessageRepository, EmailInboxWorker],
  exports: [EmailInboxService, EmailMessageRepository, EmailInboxWorker],
})
export class EmailInboxModule {}
