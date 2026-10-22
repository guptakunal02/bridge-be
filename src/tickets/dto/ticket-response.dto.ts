import {
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
  WaitingAction,
} from '../../database/enums';
import { EmailMessage } from '../../email-inbox/entities/email-message.entity';
import { formatWaId } from '../../whatsapp-inbox/wa-id-format';
import { Ticket } from '../entities/ticket.entity';
import { TicketActivityLog } from '../entities/ticket-activity-log.entity';
import { TicketNote } from '../entities/ticket-note.entity';
import {
  parseQuotedThread,
  shouldShowSubjectHeader,
  splitBody,
} from '../message-view-utils';

/**
 * Narrow shape toLatestMessage reads off a message row. Satisfied by
 * both EmailMessage (the detail path still passes the typed entity
 * in via adapters) and the raw LatestMessageRow from the `message`
 * view the inbox list hits. Kept here, not in the service, so the
 * mapper's contract is visible alongside its implementation.
 */
export interface LatestMessageSource {
  subject: string | null;
  sender: string | null;
  content: string | null;
  createdAt: Date;
  type?: MessageDirection;
  direction?: MessageDirection;
}

export interface TicketAssigneeSummary {
  id: string;
  name: string;
  role: UserRole;
}

export interface TicketLatestMessage {
  subject: string | null;
  sender: string | null;
  preview: string;
  at: string;
  direction: MessageDirection;
}

export interface TicketListItem {
  id: string;
  channelId: string;
  channelType: ChannelType;
  status: TicketStatus;
  isReopened: boolean;
  refundRelated: boolean;
  threadKey: string;
  tags: string[];
  assignee: TicketAssigneeSummary | null;
  teamId: string;
  /** Name of the team this ticket belongs to. Null if the row couldn't be resolved. */
  teamName: string | null;
  latestMessage: TicketLatestMessage | null;
  /**
   * The customer's email — i.e. the sender of the FIRST inbound
   * message on the ticket. Always the person outside the team,
   * regardless of whether the latest message is SENT or RECEIVED.
   * Backs the inbox list's "who" column so an agent always sees the
   * customer and never our own inbox address bouncing back from a
   * reply. Null only on edge-case rows that have no RECEIVED message
   * (should not exist going forward — ingest requires an inbound to
   * mint a ticket).
   */
  customerEmail: string | null;
  /**
   * Only set for WAITING / IN_FOLLOWUP tickets. The FE renders it
   * as a countdown (e.g. "auto-resolves in 42m", "returns to live
   * in 1h 12m"). Cleared to null when the ticket transitions back
   * to OPEN or RESOLVED.
   */
  resumeAt: string | null;
  /**
   * Only non-null while status === WAITING. Records what the sweep
   * will do when the wait elapses without a customer reply:
   * AUTO_RESOLVE (mark resolved) or REOPEN (flip back to OPEN).
   * Chosen by the member/admin at WAITING transition time.
   */
  waitingAction: WaitingAction | null;
  /**
   * Non-null when this ticket was minted as a continuation of a
   * RESOLVED ticket that received a customer reply AFTER the reopen
   * window. Points at the parent — detail view walks backwards from
   * here to render the full ancestor thread.
   */
  previousTicketId: string | null;
  /**
   * Number of RECEIVED messages that arrived after the caller's
   * last-read timestamp on this ticket. Meaningful only when the
   * caller is the ticket's assignee — non-mine tickets are always
   * zero. Backs the badge on the navigation rail.
   */
  unreadCount: number;
  /**
   * True when a bot_session row for this ticket is currently
   * BotSessionStatus.ACTIVE — i.e. the bot is actively driving the
   * conversation. The FE uses this to distinguish `assignee = BOT`
   * tickets that are actually being handled by the bot (show
   * "Groot") from ones parked in the FIFO queue waiting on a human
   * (show "In queue"). Both have `assignee.role === 'BOT'` on the
   * row — only the session state tells them apart.
   */
  botSessionActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAttachmentResponse {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

/**
 * Reconstructed ancestor from the quoted history of a message.
 * Populated only when the quoted content had at least one
 * "On <date>, <name> wrote:" preamble; empty otherwise. Backs the
 * "expanded prior thread" view.
 */
export interface PseudoMessageResponse {
  sender: string;
  date: string;
  body: string;
}

export interface EmailMessageResponse {
  id: string;
  channelId: string;
  ticketId: string;
  direction: MessageDirection;
  subject: string | null;
  sender: string | null;
  receiver: string[];
  /** Raw body — kept for legacy consumers. New FE renders `newContent`. */
  content: string;
  /** Raw HTML — kept for legacy consumers. */
  contentHtml: string | null;
  externalMessageId: string;
  attachments: EmailAttachmentResponse[];
  /**
   * Channel-specific payload kind. For email this is always 'text'.
   * For WhatsApp it mirrors the Meta `type` field — 'text' for
   * normal messages, 'image' / 'video' / 'document' / 'audio' for
   * media sends. The FE's WhatsApp chat bubble renders media rows
   * as an attachment card (icon + filename) instead of a text
   * bubble so agents can tell at a glance that a file was sent.
   */
  mediaKind: 'text' | 'image' | 'video' | 'document' | 'audio';
  createdAt: string;

  /* -------------------------- View fields ------------------------- */
  /**
   * Fresh reply portion of the body — quoted history stripped. Every
   * split strategy (Gmail "On <date> wrote:", "> " prefix, Outlook
   * marker, prior-content substring match) tried server-side; the
   * FE just renders this string. Equal to `content` when no quoted
   * history was detected.
   */
  newContent: string;
  /** HTML mirror of `newContent`. Null when the message had no HTML body. */
  newContentHtml: string | null;
  /**
   * Quoted history — the customer's mail client's copy of prior
   * messages. Rendered behind a "Show earlier messages" toggle on
   * the FE. Null when nothing was split off.
   */
  quotedContent: string | null;
  /** HTML mirror of `quotedContent`. Null when no HTML quote was found. */
  quotedContentHtml: string | null;
  /** True iff quotedContent or quotedContentHtml is non-null. Cached
   *  for the FE's "Show earlier messages" render check. */
  hasQuoted: boolean;
  /**
   * True when the per-message subject genuinely differs from the
   * ticket's overall subject (a mid-thread rename). False when the
   * message subject is just a Re/Fwd-prefixed variant — the sticky
   * ticket header already shows the subject, no need to repeat it
   * on every message card.
   */
  showSubjectHeader: boolean;
  /**
   * Ancestor pseudo-messages parsed out of the quoted content. Empty
   * when the quoted content had no "On <date> wrote:" preamble to
   * split on — the FE falls back to rendering the raw quoted content
   * in that case.
   */
  reconstructedThread: PseudoMessageResponse[];
}

export interface TicketActivityResponse {
  id: string;
  event: TicketActivity;
  log: string | null;
  createdAt: string;
}

/**
 * Internal note attached to a ticket. Visible to every member and
 * admin — never sent to the customer. Author is nullable because
 * the user FK is ON DELETE SET NULL (deactivated users shouldn't
 * erase their notes). FE renders a placeholder in that case.
 */
export interface TicketNoteResponse {
  id: string;
  author: TicketAssigneeSummary | null;
  body: string;
  createdAt: string;
}

export interface TicketDetail extends TicketListItem {
  messages: EmailMessageResponse[];
  activity: TicketActivityResponse[];
  notes: TicketNoteResponse[];
}

/**
 * One entry in the "all tickets from this customer" sidebar list.
 * Small on purpose — it's a jump-list, not a full ticket view.
 */
export interface RelatedTicketSummary {
  id: string;
  subject: string | null;
  status: TicketStatus;
  isReopened: boolean;
  channelType: ChannelType;
  createdAt: string;
  updatedAt: string;
}

const PREVIEW_MAX = 140;

export function toTicketListItem(
  ticket: Ticket,
  latest: LatestMessageSource | null,
  unreadCount: number = 0,
  customerEmail: string | null = null,
  botSessionActive: boolean = false,
): TicketListItem {
  // Channel-aware presentation: WhatsApp senders are raw wa_ids
  // (digits only) in the DB — format for display so the inbox row's
  // "who" column reads like a phone number, not a serial.
  const formattedCustomer = formatSenderForChannel(
    customerEmail,
    ticket.channel_type,
  );
  const latestMessage = latest
    ? toLatestMessage(latest, ticket.channel_type)
    : null;
  return {
    id: ticket.id,
    channelId: ticket.channel_id,
    channelType: ticket.channel_type,
    status: ticket.status,
    isReopened: ticket.is_reopened,
    refundRelated: ticket.refund_related,
    threadKey: ticket.thread_key,
    tags: ticket.tags ?? [],
    assignee: ticket.assigneeUser
      ? {
          id: ticket.assigneeUser.id,
          name: ticket.assigneeUser.name,
          role: ticket.assigneeUser.role,
        }
      : null,
    teamId: ticket.team_id,
    teamName: ticket.team?.name ?? null,
    latestMessage,
    customerEmail: formattedCustomer,
    resumeAt: ticket.resume_at ? ticket.resume_at.toISOString() : null,
    waitingAction: ticket.waiting_action,
    previousTicketId: ticket.previous_ticket_id ?? null,
    unreadCount,
    botSessionActive,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function formatSenderForChannel(
  raw: string | null,
  channel: ChannelType,
): string | null {
  if (!raw) return null;
  return channel === ChannelType.WHATSAPP ? formatWaId(raw) : raw;
}

export function toTicketDetail(
  ticket: Ticket,
  messages: EmailMessage[],
  activity: TicketActivityLog[],
  notes: TicketNote[],
  botSessionActive: boolean = false,
): TicketDetail {
  const latest = messages.length
    ? (messages[messages.length - 1] ?? null)
    : null;
  // View-field computation is contextual: showSubjectHeader compares
  // against the ticket subject, and the quoted-content fallback
  // matches against every prior message's body. Thread the context
  // in here so the mapper stays pure downstream.
  const ticketSubject = messages[0]?.subject ?? null;
  const priorBodies: string[] = [];
  const mappedMessages: EmailMessageResponse[] = [];
  for (const m of messages) {
    mappedMessages.push(
      toEmailMessage(m, ticketSubject, priorBodies, ticket.channel_type),
    );
    priorBodies.push(m.content ?? '');
  }
  // Customer = first inbound sender. Walking messages ascending
  // (they're ordered that way by callers) gives the oldest RECEIVED
  // which is the ticket's originator. Null if no inbound exists
  // yet — shouldn't happen going forward (ingest requires a
  // RECEIVED to mint a ticket), kept nullable for safety.
  const firstInbound = messages.find(
    (m) => m.type === MessageDirection.RECEIVED,
  );
  const customerEmail = firstInbound?.sender ?? null;
  return {
    ...toTicketListItem(ticket, latest, 0, customerEmail, botSessionActive),
    messages: mappedMessages,
    activity: activity.map(toActivity),
    notes: notes.map(toNote),
  };
}

function toNote(n: TicketNote): TicketNoteResponse {
  return {
    id: n.id,
    author: n.author
      ? { id: n.author.id, name: n.author.name, role: n.author.role }
      : null,
    body: n.body,
    createdAt: n.createdAt.toISOString(),
  };
}

function toLatestMessage(
  m: LatestMessageSource,
  channel: ChannelType,
): TicketLatestMessage {
  const raw = (m.content ?? '').replace(/\s+/g, ' ').trim();
  const preview =
    raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw;
  // Direction lives on `type` for EmailMessage entity rows and on
  // `direction` for the narrow LatestMessageRow from the message
  // view — accept either so this mapper covers both paths.
  const direction = m.type ?? m.direction;
  if (!direction) {
    throw new Error('toLatestMessage: message row missing direction');
  }
  return {
    subject: m.subject,
    sender: formatSenderForChannel(m.sender, channel),
    preview,
    at: m.createdAt.toISOString(),
    direction,
  };
}

function toEmailMessage(
  m: EmailMessage,
  ticketSubject: string | null,
  priorBodies: string[],
  channel: ChannelType,
): EmailMessageResponse {
  const split = splitBody(m.content ?? '', m.content_html ?? null, priorBodies);
  const reconstructedThread = split.quotedContent
    ? parseQuotedThread(split.quotedContent)
    : [];
  return {
    id: m.id,
    channelId: m.channelId,
    ticketId: m.ticket_id,
    direction: m.type,
    subject: m.subject,
    sender: formatSenderForChannel(m.sender, channel),
    receiver: m.receiver,
    content: m.content,
    contentHtml: m.content_html,
    externalMessageId: m.external_message_id,
    // Attachments come in via the eager-loaded relation on the
    // list() / get() paths. Older code paths that hand a plain
    // message row will still render (empty array).
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      // size_bytes stores TypeORM's bigint-as-string; parse for the
      // client.
      sizeBytes: Number(a.size_bytes),
      url: a.storage_url,
    })),
    // _waMediaKind is set by adaptWhatsappMessage on the WhatsApp
    // detail path; email never sets it so default to 'text'. The FE
    // branches on this to render media as an attachment card.
    mediaKind: m._waMediaKind ?? 'text',
    createdAt: m.createdAt.toISOString(),
    // Server-computed view fields — see message-view-utils.ts for
    // the strategy stack (heuristics → prior-content fallback).
    newContent: split.newContent,
    newContentHtml: split.newContentHtml,
    quotedContent: split.quotedContent,
    quotedContentHtml: split.quotedContentHtml,
    hasQuoted:
      split.quotedContent !== null || split.quotedContentHtml !== null,
    showSubjectHeader: shouldShowSubjectHeader(m.subject, ticketSubject),
    reconstructedThread,
  };
}

function toActivity(a: TicketActivityLog): TicketActivityResponse {
  return {
    id: a.id,
    event: a.event,
    log: a.log,
    createdAt: a.createdAt.toISOString(),
  };
}
