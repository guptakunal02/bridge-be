import {
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../../database/enums';
import { EmailMessage } from '../../email-inbox/entities/email-message.entity';
import { Ticket } from '../entities/ticket.entity';
import { TicketActivityLog } from '../entities/ticket-activity-log.entity';

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
  assignee: TicketAssigneeSummary | null;
  latestMessage: TicketLatestMessage | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailMessageResponse {
  id: string;
  channelId: string;
  ticketId: string;
  direction: MessageDirection;
  subject: string | null;
  sender: string | null;
  receiver: string[];
  content: string;
  externalMessageId: string;
  createdAt: string;
}

export interface TicketActivityResponse {
  id: string;
  event: TicketActivity;
  log: string | null;
  createdAt: string;
}

export interface TicketDetail extends TicketListItem {
  messages: EmailMessageResponse[];
  activity: TicketActivityResponse[];
}

const PREVIEW_MAX = 140;

export function toTicketListItem(
  ticket: Ticket,
  latest: EmailMessage | null,
): TicketListItem {
  return {
    id: ticket.id,
    channelId: ticket.channel_id,
    channelType: ticket.channel_type,
    status: ticket.status,
    isReopened: ticket.is_reopened,
    refundRelated: ticket.refund_related,
    threadKey: ticket.thread_key,
    assignee: ticket.assigneeUser
      ? {
          id: ticket.assigneeUser.id,
          name: ticket.assigneeUser.name,
          role: ticket.assigneeUser.role,
        }
      : null,
    latestMessage: latest ? toLatestMessage(latest) : null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

export function toTicketDetail(
  ticket: Ticket,
  messages: EmailMessage[],
  activity: TicketActivityLog[],
): TicketDetail {
  const latest = messages.length
    ? (messages[messages.length - 1] ?? null)
    : null;
  return {
    ...toTicketListItem(ticket, latest),
    messages: messages.map(toEmailMessage),
    activity: activity.map(toActivity),
  };
}

function toLatestMessage(m: EmailMessage): TicketLatestMessage {
  const raw = (m.content ?? '').replace(/\s+/g, ' ').trim();
  const preview =
    raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw;
  return {
    subject: m.subject,
    sender: m.sender,
    preview,
    at: m.createdAt.toISOString(),
    direction: m.type,
  };
}

function toEmailMessage(m: EmailMessage): EmailMessageResponse {
  return {
    id: m.id,
    channelId: m.channelId,
    ticketId: m.ticket_id,
    direction: m.type,
    subject: m.subject,
    sender: m.sender,
    receiver: m.receiver,
    content: m.content,
    externalMessageId: m.external_message_id,
    createdAt: m.createdAt.toISOString(),
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
