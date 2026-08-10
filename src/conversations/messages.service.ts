import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConversationStatus,
  Message,
  MessageAuthorType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageType,
  Prisma,
} from '@prisma/client';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import type {
  InboundMessageEvent,
  OutboundPayload,
} from '../channels/adapters/channel-adapter.port';
import { ChannelAdapterRegistry } from '../channels/adapters/channel-adapter.registry';
import { ContactsService } from '../contacts/contacts.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  MessageCreatedEvent,
  MessageUpdatedEvent,
  REALTIME_EVENTS,
} from '../realtime/events';
import { ConversationsService } from './conversations.service';
import {
  CONVERSATION_INCLUDE,
  toConversationResponse,
} from './dto/conversation-response.dto';
import type { ListMessagesDto } from './dto/list-messages.dto';
import {
  MessageListResponse,
  MessageResponse,
  toMessageResponse,
} from './dto/message-response.dto';
import type { SendMessageDto } from './dto/send-message.dto';

const DEFAULT_LIMIT = 50;

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly adapters: ChannelAdapterRegistry,
    private readonly contacts: ContactsService,
    private readonly events: EventEmitter2,
  ) {}

  private emitCreated(conversationId: string, message: MessageResponse): void {
    const payload: MessageCreatedEvent = { conversationId, message };
    this.events.emit(REALTIME_EVENTS.MessageCreated, payload);
  }

  private emitUpdated(conversationId: string, message: MessageResponse): void {
    const payload: MessageUpdatedEvent = { conversationId, message };
    this.events.emit(REALTIME_EVENTS.MessageUpdated, payload);
  }

  private async emitConversationRefreshed(
    conversationId: string,
  ): Promise<void> {
    const fresh = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: CONVERSATION_INCLUDE,
    });
    if (fresh) this.conversations.emitUpdated(toConversationResponse(fresh));
  }

  async list(
    conversationId: string,
    actor: AuthenticatedAgent,
    query: ListMessagesDto,
  ): Promise<MessageListResponse> {
    await this.conversations.loadWithAccess(conversationId, actor);

    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursorId =
      query.cursor && this.isUuid(query.cursor) ? query.cursor : undefined;

    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      cursor: cursorId ? { id: cursorId } : undefined,
      skip: cursorId ? 1 : 0,
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(
      toMessageResponse,
    );
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }

  async send(
    conversationId: string,
    actor: AuthenticatedAgent,
    dto: SendMessageDto,
  ): Promise<MessageResponse> {
    const conv = await this.conversations.loadWithAccess(conversationId, actor);

    if (
      conv.status === ConversationStatus.RESOLVED ||
      conv.status === ConversationStatus.SNOOZED
    ) {
      throw new BadRequestException(
        `Cannot send while conversation is ${conv.status}; reopen it first`,
      );
    }

    const payload = this.buildOutboundPayload(dto);

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        authorType: MessageAuthorType.AGENT,
        authorAgentId: actor.id,
        type: this.messageTypeFor(payload),
        text: payload.kind === 'TEXT' ? payload.text : null,
        mediaUrl: payload.kind !== 'TEXT' ? payload.mediaUrl : null,
        deliveryStatus: MessageDeliveryStatus.PENDING,
      },
    });
    this.emitCreated(conversationId, toMessageResponse(message));

    const adapter = this.adapters.get(conv.channel.type);
    if (!adapter) {
      await this.markFailed(
        message.id,
        `No adapter registered for channel type ${conv.channel.type}`,
      );
      throw new ServiceUnavailableException(
        `Channel type ${conv.channel.type} is not deliverable yet`,
      );
    }

    // Refetch the full Channel row (loadWithAccess returns a truncated
    // subset). Real adapters need credentialsEncrypted etc.
    const fullChannel = await this.prisma.channel.findUniqueOrThrow({
      where: { id: conv.channelId },
    });

    try {
      const result = await adapter.sendMessage({
        channel: fullChannel,
        contact: conv.contact,
        conversationId,
        payload,
      });

      const [updated] = await this.prisma.$transaction([
        this.prisma.message.update({
          where: { id: message.id },
          data: {
            deliveryStatus: MessageDeliveryStatus.SENT,
            externalId: result.externalMessageId,
          },
        }),
        this.prisma.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: result.sentAt },
        }),
      ]);

      const response = toMessageResponse(updated);
      this.emitUpdated(conversationId, response);
      await this.emitConversationRefreshed(conversationId);
      return response;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, conversationId }, 'Adapter sendMessage failed');
      const failed = await this.markFailed(message.id, reason);
      const response = toMessageResponse(failed);
      this.emitUpdated(conversationId, response);
      return response;
    }
  }

  /**
   * Ingest a single inbound message event coming from an adapter's translateInbound.
   * Idempotent on externalMessageId — safe for webhook retries.
   *
   * Not exposed over HTTP directly. Called by Phase 6 webhook receiver.
   */
  async ingestInbound(event: InboundMessageEvent): Promise<MessageResponse> {
    // Fast idempotency: if we've already recorded this externalId, return it.
    const existing = await this.prisma.message.findUnique({
      where: { externalId: event.externalMessageId },
    });
    if (existing) return toMessageResponse(existing);

    const contact = await this.contacts.upsertByExternalId({
      channelId: event.channelId,
      externalId: event.externalContactId,
      name: event.externalContactName ?? null,
      avatarUrl: event.externalContactAvatarUrl ?? null,
    });

    const conversation = await this.prisma.conversation.upsert({
      where: {
        channelId_contactId: {
          channelId: event.channelId,
          contactId: contact.id,
        },
      },
      create: {
        channelId: event.channelId,
        contactId: contact.id,
        status: ConversationStatus.OPEN,
        lastMessageAt: event.occurredAt,
        lastCustomerMessageAt: event.occurredAt,
        unreadCount: 1,
      },
      update: {
        // If the conversation was RESOLVED and the customer messages again, reopen.
        status: ConversationStatus.OPEN,
        lastMessageAt: event.occurredAt,
        lastCustomerMessageAt: event.occurredAt,
        unreadCount: { increment: 1 },
      },
    });

    const content = event.message;
    try {
      const created = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: MessageDirection.INBOUND,
          authorType: MessageAuthorType.CUSTOMER,
          externalId: event.externalMessageId,
          type: this.inboundMessageType(content),
          text: 'text' in content ? content.text : null,
          mediaUrl: 'mediaUrl' in content ? content.mediaUrl : null,
          deliveryStatus: MessageDeliveryStatus.DELIVERED,
          createdAt: event.occurredAt,
          metadata: event.metadata ?? {},
        },
      });
      const response = toMessageResponse(created);
      this.emitCreated(conversation.id, response);
      await this.emitConversationRefreshed(conversation.id);
      return response;
    } catch (err) {
      // Race: another worker inserted the same externalId first. Return existing.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.message.findUnique({
          where: { externalId: event.externalMessageId },
        });
        if (raced) return toMessageResponse(raced);
      }
      throw err;
    }
  }

  private buildOutboundPayload(dto: SendMessageDto): OutboundPayload {
    if (dto.kind === 'TEXT') {
      if (!dto.text)
        throw new BadRequestException('TEXT messages require `text`');
      return { kind: 'TEXT', text: dto.text };
    }
    if (dto.kind === 'IMAGE') {
      if (!dto.mediaUrl)
        throw new BadRequestException('IMAGE messages require `mediaUrl`');
      return { kind: 'IMAGE', mediaUrl: dto.mediaUrl, caption: dto.text };
    }
    if (!dto.mediaUrl)
      throw new BadRequestException('FILE messages require `mediaUrl`');
    return {
      kind: 'FILE',
      mediaUrl: dto.mediaUrl,
      filename: dto.mediaFilename,
    };
  }

  private messageTypeFor(payload: OutboundPayload): MessageType {
    switch (payload.kind) {
      case 'TEXT':
        return MessageType.TEXT;
      case 'IMAGE':
        return MessageType.IMAGE;
      case 'FILE':
        return MessageType.FILE;
    }
  }

  private inboundMessageType(
    content: InboundMessageEvent['message'],
  ): MessageType {
    switch (content.type) {
      case 'TEXT':
        return MessageType.TEXT;
      case 'IMAGE':
        return MessageType.IMAGE;
      case 'STORY_REPLY':
        return MessageType.STORY_REPLY;
      case 'REACTION':
        return MessageType.REACTION;
    }
  }

  private async markFailed(
    messageId: string,
    reason: string,
  ): Promise<Message> {
    return this.prisma.message.update({
      where: { id: messageId },
      data: {
        deliveryStatus: MessageDeliveryStatus.FAILED,
        errorReason: reason.slice(0, 500),
      },
    });
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
