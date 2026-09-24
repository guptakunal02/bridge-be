import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BotRuntimeService } from '../bot/runtime/bot-runtime.service';
import { S3StorageService } from '../common/storage/s3-storage.service';
import {
  BotTrigger,
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { RoutingService } from '../rules/routing.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { buildTicketContext } from '../rules/ticket-context';
import { TeamsService } from '../teams/teams.service';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { TicketLifecycleService } from '../tickets/ticket-lifecycle.service';
import { User } from '../users/entities/user.entity';
import { AssignmentPickerService } from '../users/assignment-picker.service';
import type {
  IngestEmailAttachment,
  IngestEmailInbox,
} from './dto/req.dto';
import { EmailMessage } from './entities/email-message.entity';
import { EmailMessageAttachment } from './entities/email-message-attachment.entity';
import { EmailMessageRepository } from './providers/email-message.repository';

@Injectable()
export class EmailInboxService {
  private readonly logger = new Logger(EmailInboxService.name);

  constructor(
    private readonly emails: EmailMessageRepository,
    private readonly dataSource: DataSource,
    private readonly picker: AssignmentPickerService,
    private readonly teams: TeamsService,
    private readonly router: RoutingService,
    private readonly runtime: BotRuntimeService,
    private readonly lifecycle: TicketLifecycleService,
    private readonly storage: S3StorageService,
    private readonly appSettings: AppSettingsService,
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

    // Captured inside the txn, used AFTER commit for the drain hook.
    // Non-null only when we just created a fresh ticket AND the
    // picker landed on a human agent. When it's null, no drain runs.
    let pickedAssigneeId: string | null = null;
    const { message, ticket, wasNewTicket } = await this.dataSource.transaction(
      async (mgr) => {
        const threadKey = req.external_message_id;
        const ticketRepo = mgr.getRepository(Ticket);
        const logRepo = mgr.getRepository(TicketActivityLog);
        const userRepo = mgr.getRepository(User);

        // Thread stitching order:
        //   1. Look up any prior message we've stored whose
        //      Message-ID appears in this email's References or
        //      In-Reply-To chain — that message's ticket is the
        //      one this reply belongs to.
        //   2. Fall back to matching thread_key = own Message-ID,
        //      which handles the pre-References fallback case and
        //      IMAP replay idempotency.
        // Every code path afterwards treats a hit as "this email
        // extends an existing thread" and a miss as "brand new
        // thread, mint a ticket".
        let ticket = await this.findTicketFromReferences(mgr, channelId, req);
        if (!ticket) {
          ticket = await ticketRepo.findOne({
            where: { channel_id: channelId, thread_key: threadKey },
          });
        }

        // Resolved-ticket rule: if the found ticket is RESOLVED,
        // consult the configured reopen window.
        //   * within window → reopen this ticket (status → OPEN,
        //     is_reopened = true, resolved_at cleared). The reply
        //     lands on the same thread.
        //   * past window → treat as a brand-new conversation. The
        //     old thread_key is taken by the RESOLVED ticket, so we
        //     drop the match and let the mint path below own it
        //     with a fresh thread_key derived from this email's MID.
        if (ticket && ticket.status === TicketStatus.RESOLVED) {
          const withinWindow = await this.isWithinReopenWindow(
            ticket.resolved_at,
          );
          if (withinWindow) {
            await this.reopenResolved(ticket.id, mgr);
            // Refresh the row so the message linkage below sees the
            // post-reopen status/flags.
            ticket = await ticketRepo.findOne({ where: { id: ticket.id } });
          } else {
            ticket = null;
          }
        }
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

          // Two-step assignment for FIFO fairness:
          //
          //   1. Run the round-robin picker — this stamps
          //      last_assigned_at on the chosen user (or returns BOT
          //      if nobody is eligible) and, importantly, decides
          //      WHO the next human recipient is.
          //   2. Save the new ticket parked on BOT regardless. The
          //      post-commit drain then pulls the OLDEST BOT-queued
          //      ticket to the picked agent — which is the just-
          //      created one when the queue was empty, or an older
          //      stranded ticket when the backlog is deep.
          //
          // Result: customers that waited longest get served first,
          // without changing the picker's round-robin semantics.
          pickedAssigneeId = await this.picker.pickNextAssigneeForTeam(
            targetTeamId,
            mgr,
          );
          const bot = await userRepo.findOneOrFail({
            where: { role: UserRole.BOT },
          });
          const initialAssigneeId = bot.id;
          ticket = await ticketRepo.save(
            ticketRepo.create({
              channel_id: channelId,
              channel_type: ChannelType.EMAIL,
              team_id: targetTeamId,
              thread_key: threadKey,
              assignee: initialAssigneeId,
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

          // When the picker found no live agents, log the true BOT
          // parking event now. When it did find someone, the drain
          // will log its own ASSIGNED_TO_AGENT entry on whichever
          // ticket ends up moving (possibly older than this one),
          // so we don't double-log here.
          if (pickedAssigneeId === bot.id) {
            await logRepo.save({
              ticket_id: ticket.id,
              event: TicketActivity.ASSIGNED_TO_BOT,
              actor_id: null,
              log: 'Parked on the bot — no live agents were Online',
            });
          }
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

        // Attachments — upload to S3 then persist the metadata row.
        // Done inside the txn so a partial failure (S3 up, DB down)
        // doesn't leave orphan objects referenced by nothing on our
        // side. Failure is caught per-attachment so a single 5xx
        // from S3 doesn't lose the whole email — the message row
        // still commits, and the affected attachment is logged.
        if (req.attachments && req.attachments.length > 0) {
          await this.persistAttachments(saved.id, req.attachments, mgr);
        }

        return { message: saved, ticket, wasNewTicket: isNew };
      },
    );

    // Post-commit sequence — order matters:
    //
    //   1. Try to start a bot session first. If a flow matches the
    //      TICKET_CREATED trigger and its trigger_conditions accept
    //      the context, the bot takes ownership of the conversation
    //      and the ticket must STAY on BOT while it drives. A
    //      subsequent HANDOFF step will set team_id; the next
    //      capacity-free event drains it to a human then.
    //
    //   2. If no flow matched (null returned), the ticket has no
    //      bot driver — fall through to the FIFO drain so the
    //      round-robin-chosen agent gets it.
    //
    // Reply on an existing ticket: hand to the runtime unconditionally.
    // If a paused session was parked on a question, it'll advance;
    // otherwise it's a no-op.
    let botTookOver = false;
    try {
      if (wasNewTicket) {
        const session = await this.runtime.startSession({
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
        botTookOver = session !== null;
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
      // persisted regardless. Fall through to the drain below so
      // a bot failure doesn't strand the ticket on BOT forever.
    }

    // Only drain when the bot didn't take over. This preserves FIFO
    // for the human queue while keeping the bot's ticket parked on
    // BOT until its handoff step runs.
    if (wasNewTicket && !botTookOver && pickedAssigneeId) {
      await this.lifecycle.onCapacityFreed(pickedAssigneeId);
    }

    return message;
  }

  /**
   * Walk the incoming email's References + In-Reply-To chain and
   * return the ticket its ancestor message belongs to, if any.
   *
   * Order matters: References is oldest → newest per RFC 5322,
   * and the OLDEST ancestor is the most reliable anchor because
   * it survives forwards and multi-level replies where the
   * intermediate MIDs might have been dropped. We walk from oldest
   * to newest and stop at the first match.
   *
   * Returns null when nothing in the chain matches — the caller
   * then falls through to the thread_key match / new-ticket path.
   */
  private async findTicketFromReferences(
    mgr: import('typeorm').EntityManager,
    channelId: string,
    req: IngestEmailInbox,
  ): Promise<Ticket | null> {
    const chain: string[] = [];
    if (req.references && req.references.length > 0) {
      chain.push(...req.references);
    }
    if (req.inReplyTo && !chain.includes(req.inReplyTo)) {
      chain.push(req.inReplyTo);
    }
    if (chain.length === 0) return null;

    const msgRepo = mgr.getRepository(EmailMessage);
    for (const mid of chain) {
      const prior = await msgRepo.findOne({
        where: { external_message_id: mid, channelId },
        select: { id: true, ticket_id: true },
      });
      if (prior) {
        const ticket = await mgr.getRepository(Ticket).findOne({
          where: { id: prior.ticket_id },
        });
        if (ticket) return ticket;
      }
    }
    return null;
  }

  /**
   * True when `resolvedAt` sits within the admin-configured reopen
   * window (in hours). A null timestamp is a data anomaly for a
   * RESOLVED ticket — treat it as "past window" so we err on the
   * side of creating a fresh ticket rather than silently attaching
   * to something we can't verify age of.
   *
   * A configured window of 0 disables the reopen behaviour: every
   * reply to a RESOLVED ticket becomes a new ticket. That's a valid
   * choice for teams that want closed-means-closed.
   */
  private async isWithinReopenWindow(
    resolvedAt: Date | null,
  ): Promise<boolean> {
    if (!resolvedAt) return false;
    const windowHours = await this.appSettings.getResolvedReopenWindowHours();
    if (windowHours <= 0) return false;
    const ageMs = Date.now() - resolvedAt.getTime();
    return ageMs <= windowHours * 60 * 60 * 1000;
  }

  /**
   * Flip a RESOLVED ticket back to OPEN because a fresh customer
   * reply arrived within the reopen window. Sets is_reopened so
   * the queue UI can flag it, clears resolved_at so a repeat cycle
   * (resolve → reopen → resolve → reopen) keeps working, and logs
   * a REOPENED activity entry for the audit trail.
   *
   * Conditional UPDATE on status = RESOLVED — if the row already
   * flipped away in a race (unlikely since we're inside the ingest
   * txn, but cheap defense), the write is a no-op and we skip the
   * log.
   */
  private async reopenResolved(
    ticketId: string,
    mgr: import('typeorm').EntityManager,
  ): Promise<void> {
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);
    const result = await ticketRepo
      .createQueryBuilder()
      .update()
      .set({
        status: TicketStatus.OPEN,
        is_reopened: true,
        resolved_at: null,
      })
      .where('id = :id', { id: ticketId })
      .andWhere('status = :resolved', { resolved: TicketStatus.RESOLVED })
      .execute();
    if ((result.affected ?? 0) > 0) {
      await logRepo.save({
        ticket_id: ticketId,
        event: TicketActivity.REOPENED,
        actor_id: null,
        log: 'Auto-reopened — customer replied within the reopen window',
      });
    }
  }

  /**
   * Upload the given attachments to S3 and persist the metadata
   * rows in the caller's transaction. Per-attachment try/catch so a
   * single upload failure logs and drops that one attachment,
   * rather than aborting the entire message ingest.
   */
  private async persistAttachments(
    messageId: string,
    attachments: IngestEmailAttachment[],
    mgr: import('typeorm').EntityManager,
  ): Promise<void> {
    const repo = mgr.getRepository(EmailMessageAttachment);
    for (const a of attachments) {
      try {
        const uploaded = await this.storage.upload({
          filename: a.filename,
          contentType: a.contentType,
          body: a.body,
        });
        await repo.save(
          repo.create({
            message_id: messageId,
            filename: a.filename,
            content_type: a.contentType,
            size_bytes: String(a.size),
            storage_key: uploaded.key,
            storage_url: uploaded.url,
          }),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to persist attachment "${a.filename}" on message=${messageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
