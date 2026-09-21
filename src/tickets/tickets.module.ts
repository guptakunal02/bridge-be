import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotModule } from '../bot/bot.module';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { TagsModule } from '../tags/tags.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { Ticket } from './entities/ticket.entity';
import { TicketActivityLog } from './entities/ticket-activity-log.entity';
import { TicketLifecycleService } from './ticket-lifecycle.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ticket,
      TicketActivityLog,
      EmailMessage,
      User,
      Channel,
    ]),
    UsersModule,
    // BotRuntimeService — fires TICKET_TAG_ADDED after every
    // successful tag update.
    BotModule,
    // EmailSenderService — outbound SMTP for agent replies.
    ChannelsModule,
    // TagsService — validates that every tag on a PATCH exists in
    // the admin-managed catalogue.
    TagsModule,
  ],
  controllers: [TicketsController],
  providers: [TicketsService, TicketLifecycleService],
  // Lifecycle service exported so EmailInboxService can wake paused
  // tickets on customer reply inside its ingest transaction.
  exports: [TicketsService, TicketLifecycleService],
})
export class TicketsModule {}
