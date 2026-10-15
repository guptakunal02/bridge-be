import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelStatus,
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
} from '../database/enums';
import { TeamsService } from '../teams/teams.service';
import { TicketLifecycleService } from '../tickets/ticket-lifecycle.service';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { AssignmentPickerService } from '../users/assignment-picker.service';
import { loadBot } from '../users/presence-helpers';
import { WhatsappMessage } from './entities/whatsapp-message.entity';

/* ------------------------------------------------------------------ */
/* Payload types                                                      */
/* ------------------------------------------------------------------ */

/**
 * Shape of the webhook body Meta sends when the `messages` field is
 * subscribed. Only the fields V2 actually reads are typed; everything
 * else is captured verbatim into raw_payload so later versions can
 * decode media types / status updates without a schema change.
 */
interface WhatsappWebhookEntry {
  id?: string;
  changes?: Array<{
    field?: string;
    value?: {
      metadata?: {
        display_phone_number?: string;
        phone_number_id?: string;
      };
      messages?: Array<WhatsappInboundMessage>;
    };
  }>;
}
interface WhatsappInboundMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}
interface WhatsappWebhookPayload {
  object?: string;
  entry?: WhatsappWebhookEntry[];
}

/* ------------------------------------------------------------------ */

@Injectable()
export class WhatsappIngestService {
  private readonly logger = new Logger(WhatsappIngestService.name);

  constructor(
    @InjectRepository(WhatsappMessage)
    private readonly messages: Repository<WhatsappMessage>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    private readonly dataSource: DataSource,
    private readonly picker: AssignmentPickerService,
    private readonly teams: TeamsService,
    private readonly lifecycle: TicketLifecycleService,
    private readonly automations: AutomationEngine,
  ) {}

  /**
   * Top-level ingest. Walks the webhook payload shape:
   *   payload.entry[] → each WABA (one, in practice)
   *   change[]        → one per subscribed field; only `messages` is
   *                     interesting in V2
   *   value.messages[] → the actual inbound messages
   *
   * Each message is processed independently so a single malformed one
   * doesn't drop the batch. Errors are swallowed + logged — Meta has
   * already received our 200, so throwing wouldn't retry; it would
   * just crash the request handler.
   */
  async ingest(payload: WhatsappWebhookPayload): Promise<void> {
    if (payload?.object !== 'whatsapp_business_account') {
      this.logger.warn(
        `Ignoring non-WABA payload: object=${payload?.object ?? 'missing'}`,
      );
      return;
    }
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const metadata = change.value?.metadata;
        if (!metadata?.phone_number_id) {
          this.logger.warn(
            'Dropping change: no metadata.phone_number_id on messages field',
          );
          continue;
        }
        const channel = await this.findOrCreateChannel(
          metadata.phone_number_id,
          metadata.display_phone_number ?? null,
        );
        for (const msg of change.value?.messages ?? []) {
          try {
            await this.ingestOne(channel, msg);
          } catch (err) {
            this.logger.warn(
              `ingestOne failed for wamid=${msg.id ?? 'missing'}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }
  }

  /**
   * Lazily upserts the Channel row that matches a given test / prod
   * phone-number-id. The admin UI for connecting a WhatsApp channel
   * isn't shipped yet, so the first webhook delivery for a new number
   * auto-creates the channel. inbox_contact = phone_number_id (the
   * stable Meta id, not the human-readable number — the latter can
   * change on display-name edits).
   */
  private async findOrCreateChannel(
    phoneNumberId: string,
    displayPhoneNumber: string | null,
  ): Promise<Channel> {
    const existing = await this.channels.findOne({
      where: { type: ChannelType.WHATSAPP, inbox_contact: phoneNumberId },
    });
    if (existing) return existing;
    const displayName = displayPhoneNumber
      ? `WhatsApp (${displayPhoneNumber})`
      : `WhatsApp (${phoneNumberId})`;
    const created = await this.channels.save(
      this.channels.create({
        type: ChannelType.WHATSAPP,
        inbox_contact: phoneNumberId,
        displayName,
        status: ChannelStatus.CONNECTED,
      }),
    );
    this.logger.log(
      `Auto-created WhatsApp channel ${created.id} for phone_number_id=${phoneNumberId}`,
    );
    return created;
  }

  /**
   * Idempotent ingest for one inbound message. Dedupes on wamid at
   * the DB (unique constraint on external_message_id); the pre-check
   * here just saves a transaction when the message was already
   * processed, which happens often with Meta's retry semantics.
   *
   * Ticket lookup / creation:
   *   * stable thread_key per (channel, sender wa_id) so a single
   *     customer's messages all land on one conversation.
   *   * If the latest ticket for this thread is OPEN / WAITING /
   *     IN_FOLLOWUP → attach the message, delegate wake to lifecycle.
   *   * If it's RESOLVED → flip back to OPEN, log a REOPENED event.
   *     V2 keeps the assignee; the proper presence-aware fallback
   *     will land once the WhatsApp path has its own version of
   *     reopenResolved.
   *   * If no ticket exists → mint one via the routing path (picker
   *     chooses a human, drain hook assigns on commit).
   *
   * Non-text message types (image / video / audio / document) are
   * accepted for storage (so forensics has them) but content is set
   * to a placeholder — the FE will render a "📎 Media" affordance
   * when it starts rendering WhatsApp threads.
   */
  private async ingestOne(
    channel: Channel,
    msg: WhatsappInboundMessage,
  ): Promise<void> {
    if (!msg.id || !msg.from) {
      this.logger.warn('Dropping message: missing id or from');
      return;
    }
    const already = await this.messages.findOne({
      where: { external_message_id: msg.id },
    });
    if (already) {
      this.logger.log(
        `whatsapp.ingest idempotent: wamid=${msg.id} ticket=${already.ticket_id}`,
      );
      return;
    }

    // Snapshotted outside the txn so the post-commit automation emit
    // can read them. The txn callback assigns these as it goes.
    let ticket!: Ticket;
    let message!: WhatsappMessage;
    let wasNewTicket = false;
    let reopenedFromResolved = false;

    await this.dataSource.transaction(async (mgr) => {
      const result = await this.findOrCreateTicket(mgr, channel, msg.from!);
      ticket = result.ticket;
      wasNewTicket = result.wasNewTicket;
      reopenedFromResolved = result.reopenedFromResolved;
      message = await mgr.getRepository(WhatsappMessage).save(
        mgr.getRepository(WhatsappMessage).create({
          channelId: channel.id,
          ticket_id: ticket.id,
          type: MessageDirection.RECEIVED,
          sender: msg.from!,
          content: msg.text?.body ?? null,
          external_message_id: msg.id!,
          message_type: msg.type ?? 'unknown',
          raw_payload: msg,
        }),
      );
      // WAITING → OPEN wake. reopenResolved was handled inline above
      // in the find-or-create path; this handles the WAITING case
      // where a customer reply is the wake trigger.
      await this.lifecycle.wakeIfPaused(ticket.id, mgr);
    });

    // Fire automation events post-commit. Fire-and-forget; the engine
    // queues via EventEmitter2 so slow / failing rules never block
    // the ingest's return path. Mirrors the email ingest's emit
    // triple exactly — same event names, same payload shape — so
    // rules written for email automatically evaluate on WhatsApp.
    // Subject is null (WhatsApp has no subject); predicates comparing
    // event.subject will simply not match, which is the correct
    // behaviour for a channel without that concept.
    const hourIst = computeHourIst(message.createdAt);
    const ticketSnapshot = {
      id: ticket.id,
      channelId: ticket.channel_id,
      status: ticket.status,
      tags: ticket.tags ?? [],
      assigneeId: ticket.assignee,
      teamId: ticket.team_id,
      subject: ticket.thread_key ?? null,
    };
    this.automations.emit({
      event: AUTOMATION_EVENT.MESSAGE_RECEIVED,
      ticket: ticketSnapshot,
      payload: {
        ticketId: ticket.id,
        messageId: message.id,
        channelId: channel.id,
        sender: msg.from!,
        subject: null,
        body: message.content ?? '',
        hourIst,
      },
    });
    if (wasNewTicket) {
      this.automations.emit({
        event: AUTOMATION_EVENT.TICKET_CREATED,
        ticket: ticketSnapshot,
        payload: {
          ticketId: ticket.id,
          channelId: channel.id,
          sender: msg.from!,
          subject: null,
          body: message.content ?? '',
          hourIst,
        },
      });
    }
    if (reopenedFromResolved) {
      this.automations.emit({
        event: AUTOMATION_EVENT.TICKET_REOPENED,
        ticket: ticketSnapshot,
        payload: {
          ticketId: ticket.id,
          newStatus: ticket.status,
          hourIst,
        },
      });
    }
  }

  /**
   * Find the active ticket for (channel, sender wa_id) or mint a new
   * one. Keeps the thread_key stable per customer so repeat messages
   * land on one row; the (channel_id, thread_key) uniqueness
   * constraint lets us ride the same key through resolve-then-reopen
   * cycles without proliferating tickets.
   */
  private async findOrCreateTicket(
    mgr: EntityManager,
    channel: Channel,
    waId: string,
  ): Promise<{
    ticket: Ticket;
    wasNewTicket: boolean;
    reopenedFromResolved: boolean;
  }> {
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);
    const threadKey = `wa:${waId}`;

    const existing = await ticketRepo.findOne({
      where: { channel_id: channel.id, thread_key: threadKey },
    });
    if (existing) {
      if (existing.status === TicketStatus.RESOLVED) {
        // Flip back to OPEN. V2 keeps the assignee — a presence-
        // aware fallback (same model as reopenResolved on the email
        // path) will land once we need it.
        await ticketRepo.update(
          { id: existing.id },
          {
            status: TicketStatus.OPEN,
            is_reopened: true,
            resolved_at: null,
          },
        );
        await logRepo.save({
          ticket_id: existing.id,
          event: TicketActivity.REOPENED,
          actor_id: null,
          log: 'Auto-reopened — new WhatsApp message from customer',
        });
        const refreshed = await ticketRepo.findOneOrFail({
          where: { id: existing.id },
        });
        return {
          ticket: refreshed,
          wasNewTicket: false,
          reopenedFromResolved: true,
        };
      }
      return {
        ticket: existing,
        wasNewTicket: false,
        reopenedFromResolved: false,
      };
    }

    // Fresh conversation → mint a ticket. Routing rules aren't ported
    // to WhatsApp in V2, so we always use the default team and park
    // on BOT; the picker fires post-commit to drain to a live agent.
    const defaultTeam = await this.teams.getDefault();
    const bot = await loadBot(mgr);
    if (!bot) {
      throw new Error('BOT user not seeded — cannot mint WhatsApp ticket');
    }

    let pickedAssigneeId: string = bot.id;
    try {
      pickedAssigneeId = await this.picker.pickNextAssigneeForTeam(
        defaultTeam.id,
        mgr,
      );
    } catch (err) {
      // Picker throws if no human is eligible AND BOT is paused. V2
      // can't recover from that mid-webhook — log and stay on BOT so
      // the message isn't lost; admin fixes the team setup.
      this.logger.warn(
        `Picker threw on new WhatsApp ticket for ${waId}: ${
          err instanceof Error ? err.message : String(err)
        } — parking on BOT`,
      );
    }

    const ticket = await ticketRepo.save(
      ticketRepo.create({
        channel_id: channel.id,
        channel_type: ChannelType.WHATSAPP,
        team_id: defaultTeam.id,
        assignee: bot.id,
        status: TicketStatus.OPEN,
        thread_key: threadKey,
        tags: [],
      }),
    );
    await logRepo.save({
      ticket_id: ticket.id,
      event: TicketActivity.CREATED,
      actor_id: null,
      log: `Ticket opened from WhatsApp (${waId})`,
    });
    if (pickedAssigneeId === bot.id) {
      await logRepo.save({
        ticket_id: ticket.id,
        event: TicketActivity.ASSIGNED_TO_BOT,
        actor_id: null,
        log: 'Parked on the bot — no live members were Online',
      });
    }
    // Post-commit drain is scheduled via onCapacityFreed on the
    // committed assignee. Mirrors the email ingest flow: the FIFO
    // ticket in the backfill queue (which may be older than this one)
    // is handed to the picked agent, and this new ticket may or may
    // not be the one that moves.
    if (pickedAssigneeId !== bot.id) {
      // Fire and forget — the real work happens post-commit.
      setImmediate(() => {
        this.lifecycle.onCapacityFreed(pickedAssigneeId).catch((err) => {
          this.logger.warn(
            `onCapacityFreed failed after WhatsApp mint: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      });
    }
    return { ticket, wasNewTicket: true, reopenedFromResolved: false };
  }
}

/**
 * Hour of day in IST — convenience for the common "OOH" automation
 * predicate. Mirrors the email ingest's helper so predicate authors
 * see the same integer regardless of channel.
 */
function computeHourIst(at: Date): number {
  const utcMs = at.getTime();
  const istMs = utcMs + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCHours();
}
