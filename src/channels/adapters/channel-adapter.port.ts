import type { Channel, ChannelType, Contact, Prisma } from '@prisma/client';

/**
 * Port interface every channel adapter must implement. Concrete adapters
 * (InstagramStub, Instagram/Meta, WhatsApp, Email) live under
 * src/channels/<channel>/ and are registered with ChannelAdapterRegistry.
 *
 * Nothing outside src/channels/<channel>/ should import provider-specific
 * types. The rest of the app talks to channels only through this port.
 */
export interface ChannelAdapter {
  readonly type: ChannelType;

  /**
   * Send an outbound message from an agent to a customer contact.
   * Implementations must be idempotent per (conversationId + clientMessageId)
   * once we thread a client-generated id through in Phase 3.
   */
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /**
   * Translate a raw inbound webhook payload into zero-or-more normalised
   * domain events. Returns an empty array for unsupported/irrelevant events
   * rather than throwing, so a mixed webhook batch doesn't fail as a whole.
   */
  translateInbound(rawPayload: unknown): Promise<InboundEvent[]>;
}

export interface SendMessageInput {
  channel: Channel;
  contact: Contact;
  conversationId: string;
  payload: OutboundPayload;
}

export type OutboundPayload =
  | { kind: 'TEXT'; text: string }
  | { kind: 'IMAGE'; mediaUrl: string; caption?: string }
  | { kind: 'FILE'; mediaUrl: string; filename?: string };

export interface SendMessageResult {
  externalMessageId: string;
  sentAt: Date;
}

export type InboundEvent = InboundMessageEvent;

export interface InboundMessageEvent {
  kind: 'MESSAGE';
  channelId: string;
  externalContactId: string;
  externalContactName?: string;
  externalContactAvatarUrl?: string;
  externalMessageId: string;
  occurredAt: Date;
  message: InboundMessageContent;
  // Server-internal extras persisted on Message.metadata (e.g. email subject).
  // Never surfaced via MessageResponse.
  metadata?: Prisma.InputJsonValue;
}

export type InboundMessageContent =
  | { type: 'TEXT'; text: string }
  | { type: 'IMAGE'; mediaUrl: string; caption?: string }
  | { type: 'STORY_REPLY'; text: string; storyId?: string }
  | { type: 'REACTION'; emoji: string; toExternalMessageId?: string };
