import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { BotModule } from '../bot/bot.module';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../common/storage/storage.module';
import { TeamsModule } from '../teams/teams.module';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketsModule } from '../tickets/tickets.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { WhatsappMessage } from './entities/whatsapp-message.entity';
import { WhatsappTemplate } from './entities/whatsapp-template.entity';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';
import { TemplateVariableResolverService } from './template-variable-resolver.service';
import { WhatsappIngestService } from './whatsapp-ingest.service';
import { WhatsappSenderService } from './whatsapp-sender.service';
import { WhatsappTemplatesController } from './whatsapp-templates.controller';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

/**
 * V2 of the WhatsApp inbox integration.
 *
 * Ships:
 *   * Signature-verified /webhooks/whatsapp POST (HMAC against raw body)
 *   * whatsapp_message entity + table
 *   * Channel row auto-created on first inbound per phone_number_id
 *   * Tickets minted / woken / reopened on inbound customer messages,
 *     parallel to the email ingest path's semantics
 *
 * Still deferred:
 *   * Outbound send (agent reply → Meta Graph API)
 *   * FE "Connect WhatsApp" tile + per-channel settings
 *   * Template message support (24h+ window)
 *   * Media payloads (images / documents / audio / video) — stored
 *     verbatim in raw_payload but content column is null
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Channel,
      Ticket,
      TicketActivityLog,
      User,
      EmailMessage,
      WhatsappMessage,
      WhatsappTemplate,
    ]),
    TeamsModule,
    UsersModule,
    // AutomationEngine — ingest emits MESSAGE_RECEIVED /
    // TICKET_CREATED / TICKET_REOPENED so rules fire on WhatsApp
    // inbound exactly like they do on email. forwardRef because
    // the cycle is Whatsapp → Automations → Tickets → Whatsapp;
    // without it the AutomationsModule reference is undefined by
    // the time Nest sets up WhatsappInboxModule.
    forwardRef(() => AutomationsModule),
    // S3StorageService — ingest downloads inbound media bytes from
    // Meta and stashes them in our S3 so the FE can render + the
    // agent can save-as.
    StorageModule,
    // forwardRef because TicketsModule now also imports this module
    // (so TicketsService can reach WhatsappSenderService for the
    // outbound reply path).
    forwardRef(() => TicketsModule),
    // BotRuntimeService — new WhatsApp tickets now start a bot
    // session (same way email tickets do). Enables Flow matching
    // off TICKET_CREATED and seeds sender_phone into the session's
    // initial variables.
    BotModule,
  ],
  controllers: [WhatsappWebhookController, WhatsappTemplatesController],
  providers: [
    WhatsappWebhookService,
    WhatsappIngestService,
    WhatsappSenderService,
    WhatsappTemplatesService,
    TemplateVariableResolverService,
    WhatsappSignatureGuard,
  ],
  // WhatsappSenderService is exported so TicketsService can branch
  // outbound reply on channel_type (EMAIL → SMTP, WHATSAPP → Meta
  // Graph) without reaching across module boundaries.
  // WhatsappTemplatesService + TemplateVariableResolverService are
  // exported so TicketsService can resolve + render templates during
  // the send-template path.
  exports: [
    WhatsappSenderService,
    WhatsappTemplatesService,
    TemplateVariableResolverService,
  ],
})
export class WhatsappInboxModule {}
