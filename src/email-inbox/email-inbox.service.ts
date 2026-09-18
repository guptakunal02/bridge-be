import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BotRuntimeService } from '../bot/runtime/bot-runtime.service';
import {
  BotTrigger,
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { RoutingService } from '../rules/routing.service';
import { buildTicketContext } from '../rules/ticket-context';
import { TeamsService } from '../teams/teams.service';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { TicketLifecycleService } from '../tickets/ticket-lifecycle.service';
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
    private readonly runtime: BotRuntimeService,
    private readonly lifecycle: TicketLifecycleService,
  ) {}

  /**
   * Persist an inbound email. Idempotent on external_message_id.
   *
   * Two phases so the bot runtime never runs inside our write txn:
   *   1. Idempotency short-circuit + transactional persist (ticket
   *      find-or-create, routing rules, assignee picker, email row,
   *      activity logs).
   *   2. Post-commit bot triggers. Fresh ticket → TICKET_CREATED
   *      trigger. Reply to an existing ticket → handleCustomerReply
   *      so any parked question step advances on the reply text.
   *
   * The runtime never sees an in-flight transaction, so its own
   * session writes don't fight ours for row locks.
   */
  async ingestInbound(
    channelId: string,
    req: IngestEmailInbox,
  ): Promise<EmailMessage> {
    const existing = await this.emails.findOne({
      where: { external_message_id: req.external_message_id },
    });
    if (existing) return existing;

    const { message, ticket, wasNewTicket } = await this.dataSource.transaction(
      async (mgr) => {
        const threadKey = req.external_message_id;
        const ticketRepo = mgr.getRepository(Ticket);
        const logRepo = mgr.getRepository(TicketActivityLog);
        const userRepo = mgr.getRepository(User);

        let ticket = await ticketRepo.findOne({
          where: { channel_id: channelId, thread_key: threadKey },
        });
        const isNew = !ticket;

        // Reply to an existing paused ticket → wake it now so the
        // status is OPEN by the time this txn commits. Assignee
        // unchanged; timer cleared.
        if (ticket) {
          await this.lifecycle.wakeIfPaused(ticket.id, mgr);
        }

        if (!ticket) {
          const routed = await this.router.routeFacts(
            {
              createdAt: new Date(),
              channelType: ChannelType.EMAIL,
              senderEmail: req.sender,
              subject: req.subject ?? null,
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
        const saved = await messageRepo.save(
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

        return { message: saved, ticket, wasNewTicket: isNew };
      },
    );

    // Post-commit bot dispatch. Failures here don't roll back the
    // email — the ticket is already the source of truth for humans.
    try {
      if (wasNewTicket) {
        await this.runtime.startSession({
          ticketId: ticket.id,
          channelId,
          trigger: BotTrigger.TICKET_CREATED,
          initialVariables: buildTicketContext({
            createdAt: ticket.createdAt,
            channelType: ChannelType.EMAIL,
            senderEmail: req.sender,
            subject: req.subject ?? null,
            tags: ticket.tags ?? [],
          }),
        });
      } else {
        await this.runtime.handleCustomerReply({
          ticketId: ticket.id,
          channelId,
          replyText: req.content,
        });
      }
    } catch {
      // Runtime errors already logged inside the service. Swallow
      // so the HTTP call still returns 2xx — the message is safely
      // persisted regardless.
    }

    return message;
  }
}
