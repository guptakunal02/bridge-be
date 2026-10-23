import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { BotRuntimeService } from '../bot/runtime/bot-runtime.service';
import { Channel } from '../channels/entities/channel.entity';
import { S3StorageService } from '../common/storage/s3-storage.service';
import {
  BotTrigger,
  ChannelStatus,
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
} from '../database/enums';
import { RoutingService } from '../rules/routing.service';
import { buildTicketContext } from '../rules/ticket-context';
import { AppSettingsService } from '../settings/app-settings.service';
import { TeamsService } from '../teams/teams.service';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketLifecycleService } from '../tickets/ticket-lifecycle.service';
import { AssignmentPickerService } from '../users/assignment-picker.service';
import { loadBot } from '../users/presence-helpers';
import { WhatsappMessage } from './entities/whatsapp-message.entity';
import { WhatsappSenderService } from './whatsapp-sender.service';

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
  // Media variants — Meta's webhook delivers only a media_id; the
  // bytes have to be fetched via a second Graph API call. filename
  // is only present on documents; caption is optional on all media
  // kinds except audio.
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  document?: {
    id?: string;
    mime_type?: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id?: string; mime_type?: string };
  // Interactive reply — when the customer taps a reply button or
  // picks a list row from a message the bot sent. We treat the
  // title string as the "text" for persistence and for the bot
  // runtime's option-match (which normalises labels on both sides).
  // id is the button key we sent ("opt-N"); currently unused by the
  // matcher but preserved on raw_payload for future direct-key wiring.
  interactive?: {
    type?: 'button_reply' | 'list_reply';
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
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
    private readonly router: RoutingService,
    private readonly lifecycle: TicketLifecycleService,
    private readonly automations: AutomationEngine,
    @Inject(forwardRef(() => BotRuntimeService))
    private readonly runtime: BotRuntimeService,
    private readonly sender: WhatsappSenderService,
    private readonly storage: S3StorageService,
    private readonly appSettings: AppSettingsService,
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

    // Resolve media (if any) BEFORE the txn so the Meta API round-
    // trip (network I/O) doesn't sit inside the Postgres transaction.
    // On failure we persist the row without media — agent sees an
    // empty bubble labelled by message_type, no crash.
    const media = await this.resolveInboundMedia(msg);

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
          // For text sends: the actual message body.
          // For media sends: filename (if any) so the ticket thread
          // has SOMETHING readable; caption would also go here but
          // we prefer filename when both are present. For media
          // without a filename (image/video/audio with caption or
          // without), use the caption or null.
          content:
            msg.text?.body ??
            msg.interactive?.button_reply?.title ??
            msg.interactive?.list_reply?.title ??
            media?.content ??
            null,
          external_message_id: msg.id!,
          message_type: msg.type ?? 'unknown',
          raw_payload: msg,
          media_url: media?.url ?? null,
          media_mime_type: media?.mime ?? null,
          media_size_bytes: media?.size != null ? String(media.size) : null,
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
    const dayOfWeekIst = computeDayOfWeekIst(message.createdAt);
    const ticketSnapshot = {
      id: ticket.id,
      channelId: ticket.channel_id,
      channelType: ticket.channel_type,
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
        sender: msg.from,
        subject: null,
        body: message.content ?? '',
        hourIst,
        dayOfWeekIst,
      },
    });
    if (wasNewTicket) {
      this.automations.emit({
        event: AUTOMATION_EVENT.TICKET_CREATED,
        ticket: ticketSnapshot,
        payload: {
          ticketId: ticket.id,
          channelId: channel.id,
          sender: msg.from,
          subject: null,
          body: message.content ?? '',
          hourIst,
          dayOfWeekIst,
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
          dayOfWeekIst,
        },
      });
    }

    // Bot runtime wiring — parallel to what EmailInboxService does.
    // On a brand-new WhatsApp ticket we try to start a bot session so
    // flows triggered on TICKET_CREATED fire; if the customer is
    // replying to an existing ticket, hand the message to the runtime
    // in case there's a paused session waiting on this customer's
    // next input. Errors are swallowed per-call so a bot problem
    // can't block ingest from committing a real customer message.
    //
    // `senderPhone` seeds the session so Function steps keyed by
    // phone (get_latest_order_tracking_link, get_customer_type) resolve
    // without the admin having to manually plumb the input.
    try {
      if (wasNewTicket) {
        await this.runtime.startSession({
          ticketId: ticket.id,
          channelId: channel.id,
          trigger: BotTrigger.TICKET_CREATED,
          initialVariables: buildTicketContext({
            createdAt: ticket.createdAt,
            channelType: ChannelType.WHATSAPP,
            senderEmail: null,
            senderPhone: msg.from ?? null,
            subject: null,
            tags: ticket.tags ?? [],
            latestCustomerMessageAt: ticket.createdAt,
          }),
        });
      } else {
        // Pass through the WhatsApp button/list `id` when the inbound
        // was an interactive-reply tap. The runtime decodes it as
        // `${stepId}:${index}` and routes deterministically to that
        // step + option, bypassing label matching entirely. Falls
        // through to label match (sibling scan) for text replies or
        // legacy sessions where buttons were sent without encoded ids.
        const optionId =
          msg.interactive?.button_reply?.id ??
          msg.interactive?.list_reply?.id ??
          undefined;
        await this.runtime.handleCustomerReply({
          ticketId: ticket.id,
          channelId: channel.id,
          replyText: message.content ?? '',
          optionId,
        });
      }
    } catch (err) {
      this.logger.warn(
        `WhatsApp bot runtime error on ticket=${ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Resolve the media payload (if any) on an inbound message:
   * fetch the bytes from Meta → upload to our S3 → return the
   * attachment metadata the ingest will persist on the row.
   *
   * Returns null for text / unknown / reaction / interactive /
   * sticker / location kinds we don't surface yet; those keep the
   * old "message_type recorded, no bytes" behavior. Failures
   * (expired media_id, Meta transient 5xx, S3 upload failure) log a
   * warn and return null so the row is still persisted — the agent
   * sees an empty bubble instead of the message disappearing.
   */
  private async resolveInboundMedia(msg: WhatsappInboundMessage): Promise<{
    url: string;
    mime: string;
    size: number;
    content: string | null;
  } | null> {
    const kind = msg.type;
    let payload:
      | { id?: string; mime_type?: string; filename?: string; caption?: string }
      | undefined;
    if (kind === 'image') payload = msg.image;
    else if (kind === 'video') payload = msg.video;
    else if (kind === 'document') payload = msg.document;
    else if (kind === 'audio') payload = msg.audio;
    else return null;
    if (!payload?.id) {
      this.logger.warn(
        `Inbound ${kind} message has no media id — wamid=${msg.id ?? 'missing'}`,
      );
      return null;
    }
    try {
      const { body, mime, size } = await this.sender.downloadMetaMedia(
        payload.id,
      );
      // Filename: for documents Meta gives us the real one. For
      // other kinds the customer didn't name the file (phone upload)
      // — synthesise a sensible one off the mime so the S3 object
      // key doesn't end in an empty segment and the Download menu
      // on the FE has something to show.
      const filename =
        payload.filename ?? `whatsapp-${kind}-${payload.id}${extForMime(mime)}`;
      const uploaded = await this.storage.upload({
        filename,
        contentType: mime,
        body,
      });
      // Content line surfaced in the thread for media messages:
      // caption wins (customer wrote it), then filename for docs,
      // then null for a nameless image/video/audio. The FE bubble
      // ignores this for images (thumbnail only) but shows it in
      // the file card for other kinds.
      const content =
        payload.caption ?? (kind === 'document' ? filename : null);
      return { url: uploaded.url, mime, size, content };
    } catch (err) {
      this.logger.warn(
        `Failed to download inbound ${kind} media for wamid=${msg.id ?? 'missing'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
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
    // Non-null only in the past-window continuation path below — the
    // old RESOLVED ticket is remembered on the newly minted sibling
    // via previous_ticket_id so the detail view can walk the ancestor
    // chain (same model as email's continuedFromTicketId).
    let previousTicketId: string | null = null;
    if (existing) {
      if (existing.status === TicketStatus.RESOLVED) {
        const withinWindow = await this.isWithinReopenWindow(
          existing.resolved_at,
        );
        if (withinWindow) {
          // In-window: flip the same ticket back to OPEN.
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
        // Past window → fall through to the mint path with a
        // previous_ticket_id link. The old ticket's thread_key has
        // to move out of the way so the new ticket can take
        // `wa:${waId}` and future messages still land on the latest
        // conversation. We suffix the archived key with the
        // resolved_at timestamp — guaranteed unique per
        // resolve-cycle, and distinguishable from a live key by the
        // ":archived:" segment.
        const archivedKey = `wa:${waId}:archived:${
          existing.resolved_at?.getTime() ?? Date.now()
        }`;
        await ticketRepo.update(
          { id: existing.id },
          { thread_key: archivedKey },
        );
        previousTicketId = existing.id;
      } else {
        return {
          ticket: existing,
          wasNewTicket: false,
          reopenedFromResolved: false,
        };
      }
    }

    // Fresh conversation → mint a ticket. Routing rules now evaluate
    // on WhatsApp too (mirrors the email ingest path), so admin-
    // authored OOH / team-attribute rules apply end-to-end. If no
    // rule matches, the ticket falls through to the default team.
    const now = new Date();
    const routed = await this.router.routeFacts(
      {
        createdAt: now,
        channelId: channel.id,
        channelType: ChannelType.WHATSAPP,
        senderEmail: null,
        senderPhone: waId,
        subject: null,
        tags: [],
        // First message = both the ticket's birth time and the
        // latest customer message time.
        latestCustomerMessageAt: now,
      },
      mgr,
    );
    const defaultTeam = await this.teams.getDefault();
    let targetTeamId = routed?.teamId ?? defaultTeam.id;

    const bot = await loadBot(mgr);
    if (!bot) {
      throw new Error('BOT user not seeded — cannot mint WhatsApp ticket');
    }

    let pickedAssigneeId: string = bot.id;
    // Picker fallback: if the routed team has nobody eligible (no
    // Online members AND BOT paused for that team), fall back to the
    // default team which is guaranteed to have BOT available. Mirrors
    // email ingest's fallback — no silent message loss on a mis-
    // configured team's assignment settings.
    try {
      pickedAssigneeId = await this.picker.pickNextAssigneeForTeam(
        targetTeamId,
        mgr,
      );
    } catch (pickErr) {
      if (targetTeamId === defaultTeam.id) {
        this.logger.warn(
          `Picker threw on new WhatsApp ticket for ${waId} on default team: ${
            pickErr instanceof Error ? pickErr.message : String(pickErr)
          } — parking on BOT`,
        );
      } else {
        this.logger.warn(
          `routing picked team=${targetTeamId} has no eligible assignee (${
            (pickErr as Error).message
          }); falling back to default team=${defaultTeam.id}`,
        );
        targetTeamId = defaultTeam.id;
        try {
          pickedAssigneeId = await this.picker.pickNextAssigneeForTeam(
            targetTeamId,
            mgr,
          );
        } catch (fallbackErr) {
          this.logger.warn(
            `Picker threw on fallback to default team: ${
              fallbackErr instanceof Error
                ? fallbackErr.message
                : String(fallbackErr)
            } — parking on BOT`,
          );
        }
      }
    }

    const ticket = await ticketRepo.save(
      ticketRepo.create({
        channel_id: channel.id,
        channel_type: ChannelType.WHATSAPP,
        team_id: targetTeamId,
        assignee: bot.id,
        status: TicketStatus.OPEN,
        thread_key: threadKey,
        tags: [],
        // Non-null only in the past-window continuation path. The
        // detail view walks this backwards to render the ancestor
        // thread with a "New ticket started here" divider.
        previous_ticket_id: previousTicketId,
      }),
    );
    await logRepo.save({
      ticket_id: ticket.id,
      event: TicketActivity.CREATED,
      actor_id: null,
      log: routed
        ? `Ticket opened from WhatsApp (${waId}) — routed by rule "${routed.matchedRule.name}"`
        : `Ticket opened from WhatsApp (${waId})`,
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

  /**
   * Reopen-window check for WhatsApp — mirrors the email helper but
   * reads the WA-specific configured hours so admins can tune the two
   * channels independently (WhatsApp conversations tend to span more
   * calendar time than email ones). windowHours = 0 disables
   * auto-reopen entirely → every message past resolve mints a sibling.
   */
  private async isWithinReopenWindow(
    resolvedAt: Date | null,
  ): Promise<boolean> {
    if (!resolvedAt) return false;
    const windowHours =
      await this.appSettings.getWhatsappResolvedReopenWindowHours();
    if (windowHours <= 0) return false;
    const ageMs = Date.now() - resolvedAt.getTime();
    return ageMs <= windowHours * 60 * 60 * 1000;
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

/** Day-of-week (0=Sun…6=Sat, JS Date.getDay() convention) in IST. */
function computeDayOfWeekIst(at: Date): number {
  const utcMs = at.getTime();
  const istMs = utcMs + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCDay();
}

/**
 * Minimal mime → extension map for synthesising filenames on
 * nameless inbound media. S3 keys end in the extension so the
 * browser's Save-As dialog defaults to a usable name. Covers every
 * mime WhatsApp Business API actually sends; falls through to a
 * generic ".bin" if the mime is one we haven't catalogued (defensive
 * — Meta occasionally sends vendor-specific variants).
 */
function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'video/mp4') return '.mp4';
  if (m === 'video/3gpp' || m === 'video/3gp') return '.3gp';
  if (m === 'audio/mpeg') return '.mp3';
  if (m === 'audio/mp4') return '.m4a';
  if (m === 'audio/aac') return '.aac';
  if (m === 'audio/amr') return '.amr';
  if (m === 'audio/ogg') return '.ogg';
  if (m === 'application/pdf') return '.pdf';
  return '.bin';
}
