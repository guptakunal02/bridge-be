import {
  Agent,
  ChannelType,
  Contact,
  ConversationStatus,
  Prisma,
} from '@prisma/client';

export const CONVERSATION_INCLUDE = {
  channel: { select: { id: true, type: true, displayName: true } },
  contact: true,
  assignedAgent: true,
} as const satisfies Prisma.ConversationInclude;

export type ConversationWithRelations = Prisma.ConversationGetPayload<{
  include: typeof CONVERSATION_INCLUDE;
}>;

export interface ContactSummary {
  id: string;
  externalId: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface ChannelSummary {
  id: string;
  type: ChannelType;
  displayName: string;
}

export interface ConversationResponse {
  id: string;
  status: ConversationStatus;
  channel: ChannelSummary;
  contact: ContactSummary;
  assignedAgent: AgentSummary | null;
  lastMessageAt: string;
  lastCustomerMessageAt: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListResponse {
  items: ConversationResponse[];
  nextCursor: string | null;
}

export function toContactSummary(contact: Contact): ContactSummary {
  return {
    id: contact.id,
    externalId: contact.externalId,
    name: contact.name,
    avatarUrl: contact.avatarUrl,
  };
}

export function toAgentSummary(agent: Agent | null): AgentSummary | null {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    avatarUrl: agent.avatarUrl,
  };
}

export function toConversationResponse(
  conv: ConversationWithRelations,
): ConversationResponse {
  return {
    id: conv.id,
    status: conv.status,
    channel: conv.channel,
    contact: toContactSummary(conv.contact),
    assignedAgent: toAgentSummary(conv.assignedAgent),
    lastMessageAt: conv.lastMessageAt.toISOString(),
    lastCustomerMessageAt: conv.lastCustomerMessageAt?.toISOString() ?? null,
    unreadCount: conv.unreadCount,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
  };
}
