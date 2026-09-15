import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { RoutingService } from '../rules/routing.service';
import { TeamsService } from '../teams/teams.service';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { User } from '../users/entities/user.entity';
import { AssignmentPickerService } from '../users/assignment-picker.service';
import type { IngestEmailInbox } from './dto/req.dto';
import { EmailMessage } from './entities/email-message.entity';
import { EmailMessageRepository } from './providers/email-message.repository';

@Injectable()
export class EmailInboxService {
  constructor(
    private readonly emails: EmailMessageRepository,
    private readonly dataSource: DataSource,
    private readonly picker: AssignmentPickerService,
    private readonly teams: TeamsService,
    private readonly router: RoutingService,
  ) {}

  /**
   * Persist an inbound email. Idempotent on external_message_id.
   *
   * Flow:
   *   1. Idempotency short-circuit outside the txn (fast path for
   *      IMAP replays / worker retries).
   *   2. Inside a single transaction:
   *      a. Find-or-create the Ticket for this thread. For MVP the
   *         thread_key is the email's own Message-ID (one ticket per
   *         email); real threading via References/In-Reply-To
   *         headers is a follow-up.
   *      b. Ask the AssignmentPickerService for the next assignee —
   *         round-robins among Online agents, falls back to BOT when
   *         nobody is live.
   *      c. Insert the EmailMessage row.
   *      d. Log CREATED, then either ASSIGNED_TO_AGENT or
   *         ASSIGNED_TO_BOT depending on the picker's choice.
   *
   * Transactional: a crash mid-way leaves no orphaned tickets or logs.
   */
  async ingestInbound(
    channelId: string,
    req: IngestEmailInbox,
  ): Promise<EmailMessage> {
    const existing = await this.emails.findOne({
      where: { external_message_id: req.external_message_id },
    });
    if (existing) return existing;

    return this.dataSource.transaction(async (mgr) => {
      const threadKey = req.external_message_id;
      const ticketRepo = mgr.getRepository(Ticket);
      const logRepo = mgr.getRepository(TicketActivityLog);
      const userRepo = mgr.getRepository(User);

      let ticket = await ticketRepo.findOne({
        where: { channel_id: channelId, thread_key: threadKey },
      });

      if (!ticket) {
        // Route via active rules first. First matching rule wins;
        // fall back to the default team when nothing matches.
        const routed = await this.router.routeFacts(
          {
            createdAt: new Date(),
            channelType: ChannelType.EMAIL,
            senderEmail: req.sender,
            subject: req.subject ?? null,
            // Tags are always empty at ingest — a rule that keys off
            // tags only matches after someone tags the ticket. That
            // limitation is documented in the FE builder.
            tags: [],
          },
          mgr,
        );
        const targetTeamId =
          routed?.teamId ?? (await this.teams.getDefault()).id;

        const assigneeId = await this.picker.pickNextAssigneeForTeam(
          targetTeamId,
          mgr,
        );
        ticket = await ticketRepo.save(
          ticketRepo.create({
            channel_id: channelId,
            channel_type: ChannelType.EMAIL,
            team_id: targetTeamId,
            thread_key: threadKey,
            assignee: assigneeId,
            status: TicketStatus.OPEN,
          }),
        );

        await logRepo.save({
          ticket_id: ticket.id,
          event: TicketActivity.CREATED,
          actor_id: null,
          log: routed
            ? `Ticket opened from ${req.sender} — routed by rule "${routed.matchedRule.name}"`
            : `Ticket opened from ${req.sender}`,
        });

        const assignee = await userRepo.findOneOrFail({
          where: { id: assigneeId },
        });
        await logRepo.save({
          ticket_id: ticket.id,
          event:
            assignee.role === UserRole.BOT
              ? TicketActivity.ASSIGNED_TO_BOT
              : TicketActivity.ASSIGNED_TO_AGENT,
          actor_id: null,
          log:
            assignee.role === UserRole.BOT
              ? 'Parked on the bot — no live agents were Online'
              : `Auto-assigned to ${assignee.name}`,
        });
      }

      const messageRepo = mgr.getRepository(EmailMessage);
      return messageRepo.save(
        messageRepo.create({
          channelId,
          ticket_id: ticket.id,
          type: MessageDirection.RECEIVED,
          subject: req.subject ?? null,
          content: req.content,
          content_html: req.contentHtml ?? null,
          sender: req.sender,
          receiver: req.receiver,
          external_message_id: req.external_message_id,
        }),
      );
    });
  }
}
