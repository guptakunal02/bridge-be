import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { BotModule } from '../bot/bot.module';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import { RulesModule } from '../rules/rules.module';
import { SettingsModule } from '../settings/settings.module';
import { TeamsModule } from '../teams/teams.module';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { WhatsappInboxModule } from '../whatsapp-inbox/whatsapp-inbox.module';
import { EmailInboxController } from './email-inbox.controller';
import { EmailInboxService } from './email-inbox.service';
import { EmailInboxWorker } from './email-inbox.worker';
import { EmailTemplatesController } from './email-templates.controller';
import { EmailTemplatesService } from './email-templates.service';
import { EmailMessage } from './entities/email-message.entity';
import { EmailMessageAttachment } from './entities/email-message-attachment.entity';
import { EmailTemplate } from './entities/email-template.entity';
import { EmailMessageRepository } from './providers/email-message.repository';
import { ImapResumeStore } from './providers/imap-resume-store.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EmailMessage,
      EmailMessageAttachment,
      EmailTemplate,
      Channel,
      // EmailTemplatesService.sendOnTicket needs the Ticket repo
      // to load the ticket + its channel + thread history before
      // rendering + sending the template.
      Ticket,
    ]),
    ChannelsModule,
    // TemplateVariableResolverService + EmailSenderService (via
    // ChannelsModule) power the email templates test-send flow.
    WhatsappInboxModule,
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
    // TicketLifecycleService — wakes WAITING/IN_FOLLOWUP tickets when
    // the customer replies (inside the ingest transaction).
    TicketsModule,
    // AppSettingsService — configurable reopen window for RESOLVED
    // tickets that receive a fresh reply.
    SettingsModule,
    // AutomationEngine — emit ticket.created / message.received
    // on every inbound persist. forwardRef because the send_email_template
    // handler on the automations side imports EmailTemplatesService
    // back from this module, closing the cycle.
    forwardRef(() => AutomationsModule),
  ],
  controllers: [EmailInboxController, EmailTemplatesController],
  providers: [
    EmailInboxService,
    EmailMessageRepository,
    EmailInboxWorker,
    ImapResumeStore,
    EmailTemplatesService,
  ],
  exports: [
    EmailInboxService,
    EmailMessageRepository,
    EmailInboxWorker,
    EmailTemplatesService,
  ],
})
export class EmailInboxModule {}
