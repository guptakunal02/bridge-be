import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { TeamsModule } from '../teams/teams.module';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketsModule } from '../tickets/tickets.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { WhatsappMessage } from './entities/whatsapp-message.entity';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';
import { WhatsappIngestService } from './whatsapp-ingest.service';
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
    TypeOrmModule.forFeature([Channel, Ticket, TicketActivityLog, User, WhatsappMessage]),
    TeamsModule,
    UsersModule,
    TicketsModule,
  ],
  controllers: [WhatsappWebhookController],
  providers: [WhatsappWebhookService, WhatsappIngestService, WhatsappSignatureGuard],
})
export class WhatsappInboxModule {}
