import {
  Message,
  MessageAuthorType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageType,
} from '@prisma/client';

export interface MessageResponse {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  authorType: MessageAuthorType;
  authorUserId: string | null;
  externalId: string | null;
  type: MessageType;
  text: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  replyToMessageId: string | null;
  deliveryStatus: MessageDeliveryStatus;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageListResponse {
  items: MessageResponse[];
  nextCursor: string | null;
}

export function toMessageResponse(m: Message): MessageResponse {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    authorType: m.authorType,
    authorUserId: m.authorUserId,
    externalId: m.externalId,
    type: m.type,
    text: m.text,
    mediaUrl: m.mediaUrl,
    mediaMimeType: m.mediaMimeType,
    replyToMessageId: m.replyToMessageId,
    deliveryStatus: m.deliveryStatus,
    errorReason: m.errorReason,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
