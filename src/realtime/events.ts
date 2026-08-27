// Domain events emitted onto @nestjs/event-emitter and picked up by the
// UserGateway to broadcast over Socket.IO. Everything a client can observe
// flows through one of these events — services never call the gateway directly.

import type { UserStatus } from '@prisma/client';
import type { ConversationResponse } from '../conversations/dto/conversation-response.dto';
import type { MessageResponse } from '../conversations/dto/message-response.dto';

export const REALTIME_EVENTS = {
  MessageCreated: 'realtime.message.created',
  MessageUpdated: 'realtime.message.updated',
  ConversationUpdated: 'realtime.conversation.updated',
  PresenceUpdated: 'realtime.presence.updated',
} as const;

export interface MessageCreatedEvent {
  conversationId: string;
  message: MessageResponse;
}

export interface MessageUpdatedEvent {
  conversationId: string;
  message: MessageResponse;
}

export interface ConversationUpdatedEvent {
  conversation: ConversationResponse;
}

export interface PresenceUpdatedEvent {
  userId: string;
  status: UserStatus;
  lastSeenAt: string | null;
}
