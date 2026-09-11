import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { User } from '../users/entities/user.entity';
import type { IngestEmailInbox } from './dto/req.dto';
import { EmailMessage } from './entities/email-message.entity';
import { EmailMessageRepository } from './providers/email-message.repository';

@Injectable()
export class EmailInboxService {
  constructor(
    private readonly emails: EmailMessageRepository,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Persist an inbound email. Idempotent on external_message_id.
   *
   * Flow:
   *   1. If we've already stored this Message-ID, return the existing row
   *      (dedup for IMAP replays / worker retries).
   *   2. Otherwise, inside a single transaction:
   *      a. Find-or-create the Ticket for this thread. For MVP the
   *         thread_key is the email's own Message-ID (one ticket per
   *         email); real threading via References/In-Reply-To headers
   *         is a follow-up.
   *      b. Insert the EmailMessage row.
   *      c. Log a CREATED activity on the ticket.
   *
   * Transactional: a crash mid-way leaves no orphaned tickets or logs.
   */
  async ingestInbound(
    channelId: string,
    req: IngestEmailInbox,
  ): Promise<EmailMessage> {
    // 1. Idempotency short-circuit (outside the txn — fast path)
    const existing = await this.emails.findOne({
      where: { external_message_id: req.external_message_id },
    });
    if (existing) return existing;

    return this.dataSource.transaction(async (mgr) => {
      // 2a. Ticket assignee defaults to the BOT user
      const bot = await mgr.getRepository(User).findOne({
        where: { role: UserRole.BOT },
      });
      if (!bot) {
        throw new NotFoundException(
          'BOT user is not seeded — cannot assign new tickets',
        );
      }

      // Find-or-create the ticket by (channel_id, thread_key)
      const threadKey = req.external_message_id;
      const ticketRepo = mgr.getRepository(Ticket);
      let ticket = await ticketRepo.findOne({
        where: { channel_id: channelId, thread_key: threadKey },
      });
      if (!ticket) {
        ticket = await ticketRepo.save(
          ticketRepo.create({
            channel_id: channelId,
            channel_type: ChannelType.EMAIL,
            thread_key: threadKey,
            assignee: bot.id,
            status: TicketStatus.OPEN,
          }),
        );

        // Log CREATED only on the first insert
        await mgr.getRepository(TicketActivityLog).save({
          ticket_id: ticket.id,
          event: TicketActivity.CREATED,
          log: `Ticket opened from inbound email ${req.external_message_id}`,
        });
      }

      // 2b. Persist the email row
      const messageRepo = mgr.getRepository(EmailMessage);
      return messageRepo.save(
        messageRepo.create({
          channelId,
          ticket_id: ticket.id,
          type: MessageDirection.RECEIVED,
          subject: req.subject ?? null,
          content: req.content,
          sender: req.sender,
          receiver: req.receiver,
          external_message_id: req.external_message_id,
        }),
      );
    });
  }
}
