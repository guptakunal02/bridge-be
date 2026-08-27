import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationStatus, Prisma, UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ChannelsService } from '../channels/channels.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationUpdatedEvent, REALTIME_EVENTS } from '../realtime/events';
import {
  CONVERSATION_INCLUDE,
  ConversationListResponse,
  ConversationResponse,
  ConversationWithRelations,
  toConversationResponse,
} from './dto/conversation-response.dto';
import type {
  AssigneeFilter,
  ListConversationsDto,
} from './dto/list-conversations.dto';

const DEFAULT_LIMIT = 25;

const USER_VISIBLE_STATUSES: ConversationStatus[] = [
  ConversationStatus.OPEN,
  ConversationStatus.PENDING,
];

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
    private readonly events: EventEmitter2,
  ) {}

  emitUpdated(conversation: ConversationResponse): void {
    const payload: ConversationUpdatedEvent = { conversation };
    this.events.emit(REALTIME_EVENTS.ConversationUpdated, payload);
  }

  async list(
    actor: AuthenticatedUser,
    query: ListConversationsDto,
  ): Promise<ConversationListResponse> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const where = await this.buildListWhere(actor, query);

    const cursorId =
      query.cursor && this.isUuid(query.cursor) ? query.cursor : undefined;

    const rows = await this.prisma.conversation.findMany({
      where,
      include: CONVERSATION_INCLUDE,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      cursor: cursorId ? { id: cursorId } : undefined,
      skip: cursorId ? 1 : 0,
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(
      toConversationResponse,
    );
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }

  async get(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    const conv = await this.loadWithAccess(id, actor);
    return toConversationResponse(conv);
  }

  async updateStatus(
    id: string,
    status: ConversationStatus,
    actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    const existing = await this.loadWithAccess(id, actor);
    if (existing.status === status) {
      return toConversationResponse(existing);
    }
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { status },
      include: CONVERSATION_INCLUDE,
    });
    const response = toConversationResponse(updated);
    this.emitUpdated(response);
    return response;
  }

  async assign(
    id: string,
    targetUserId: string | null,
    actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    const conv = await this.loadWithAccess(id, actor);
    const isAdmin = actor.role === UserRole.ADMIN;

    if (targetUserId === null) {
      // Unassign — admin can always; member can only unassign themselves.
      if (!isAdmin && conv.assignedUserId !== actor.id) {
        throw new ForbiddenException('Members can only unassign themselves');
      }
    } else if (targetUserId === actor.id) {
      // Self-assign — allowed for any authorised viewer.
    } else if (!isAdmin) {
      throw new ForbiddenException(
        'Only admins can assign conversations to other users',
      );
    } else {
      // Admin assigning to someone else: they must be on this channel.
      const hasAccess = await this.prisma.userChannel.findUnique({
        where: {
          userId_channelId: {
            userId: targetUserId,
            channelId: conv.channelId,
          },
        },
        select: { userId: true },
      });
      if (!hasAccess) {
        throw new BadRequestException(
          'Target user is not assigned to this channel; grant channel access first',
        );
      }
      const user = await this.prisma.user.findUnique({
        where: { id: targetUserId },
        select: { deactivatedAt: true },
      });
      if (!user || user.deactivatedAt !== null) {
        throw new BadRequestException('Target user is not active');
      }
    }

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { assignedUserId: targetUserId },
      include: CONVERSATION_INCLUDE,
    });
    const response = toConversationResponse(updated);
    this.emitUpdated(response);
    return response;
  }

  async markRead(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    const conv = await this.loadWithAccess(id, actor);
    if (conv.unreadCount === 0) {
      return toConversationResponse(conv);
    }
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
      include: CONVERSATION_INCLUDE,
    });
    const response = toConversationResponse(updated);
    this.emitUpdated(response);
    return response;
  }

  /**
   * Load a conversation and verify the actor may view it. Used by both this
   * service and MessagesService — kept in one place so scoping rules don't drift.
   */
  async loadWithAccess(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<ConversationWithRelations> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: CONVERSATION_INCLUDE,
    });

    if (!conv) throw new NotFoundException('Conversation not found');

    if (actor.role !== UserRole.ADMIN) {
      const membership = await this.prisma.userChannel.findUnique({
        where: {
          userId_channelId: { userId: actor.id, channelId: conv.channelId },
        },
        select: { userId: true },
      });
      if (!membership) {
        throw new NotFoundException('Conversation not found');
      }
    }

    return conv;
  }

  private async buildListWhere(
    actor: AuthenticatedUser,
    query: ListConversationsDto,
  ): Promise<Prisma.ConversationWhereInput> {
    const isAdmin = actor.role === UserRole.ADMIN;
    const assignee: AssigneeFilter = query.assignee ?? (isAdmin ? 'all' : 'me');
    const status = query.status ?? USER_VISIBLE_STATUSES;

    const where: Prisma.ConversationWhereInput = {
      status: { in: status },
    };

    if (query.channelId) {
      where.channelId = query.channelId;
    }

    if (!isAdmin) {
      const channelIds = await this.channels.getChannelIdsForUser(actor.id);
      if (channelIds.length === 0) {
        // Member has no channel access — an impossible filter returns nothing.
        return { id: { in: [] } };
      }
      if (query.channelId && !channelIds.includes(query.channelId)) {
        return { id: { in: [] } };
      }
      where.channelId = query.channelId ?? { in: channelIds };
    }

    if (assignee === 'me') {
      where.assignedUserId = actor.id;
    } else if (assignee === 'unassigned') {
      where.assignedUserId = null;
    }
    // assignee === 'all' → no assignee filter

    return where;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
