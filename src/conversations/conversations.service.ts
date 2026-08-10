import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AgentRole, ConversationStatus, Prisma } from '@prisma/client';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import { ChannelsService } from '../channels/channels.service';
import { PrismaService } from '../prisma/prisma.service';
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

const AGENT_VISIBLE_STATUSES: ConversationStatus[] = [
  ConversationStatus.OPEN,
  ConversationStatus.PENDING,
];

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
  ) {}

  async list(
    actor: AuthenticatedAgent,
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
    actor: AuthenticatedAgent,
  ): Promise<ConversationResponse> {
    const conv = await this.loadWithAccess(id, actor);
    return toConversationResponse(conv);
  }

  async updateStatus(
    id: string,
    status: ConversationStatus,
    actor: AuthenticatedAgent,
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
    return toConversationResponse(updated);
  }

  async assign(
    id: string,
    targetAgentId: string | null,
    actor: AuthenticatedAgent,
  ): Promise<ConversationResponse> {
    const conv = await this.loadWithAccess(id, actor);
    const isAdmin = actor.role === AgentRole.ADMIN;

    if (targetAgentId === null) {
      // Unassign — admin can always; agent can only unassign themselves.
      if (!isAdmin && conv.assignedAgentId !== actor.id) {
        throw new ForbiddenException('Agents can only unassign themselves');
      }
    } else if (targetAgentId === actor.id) {
      // Self-assign — allowed for any authorised viewer.
    } else if (!isAdmin) {
      throw new ForbiddenException(
        'Only admins can assign conversations to other agents',
      );
    } else {
      // Admin assigning to someone else: they must be on this channel.
      const hasAccess = await this.prisma.agentChannel.findUnique({
        where: {
          agentId_channelId: {
            agentId: targetAgentId,
            channelId: conv.channelId,
          },
        },
        select: { agentId: true },
      });
      if (!hasAccess) {
        throw new BadRequestException(
          'Target agent is not assigned to this channel; grant channel access first',
        );
      }
      const agent = await this.prisma.agent.findUnique({
        where: { id: targetAgentId },
        select: { deactivatedAt: true },
      });
      if (!agent || agent.deactivatedAt !== null) {
        throw new BadRequestException('Target agent is not active');
      }
    }

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { assignedAgentId: targetAgentId },
      include: CONVERSATION_INCLUDE,
    });
    return toConversationResponse(updated);
  }

  async markRead(
    id: string,
    actor: AuthenticatedAgent,
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
    return toConversationResponse(updated);
  }

  /**
   * Load a conversation and verify the actor may view it. Used by both this
   * service and MessagesService — kept in one place so scoping rules don't drift.
   */
  async loadWithAccess(
    id: string,
    actor: AuthenticatedAgent,
  ): Promise<ConversationWithRelations> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: CONVERSATION_INCLUDE,
    });

    if (!conv) throw new NotFoundException('Conversation not found');

    if (actor.role !== AgentRole.ADMIN) {
      const membership = await this.prisma.agentChannel.findUnique({
        where: {
          agentId_channelId: { agentId: actor.id, channelId: conv.channelId },
        },
        select: { agentId: true },
      });
      if (!membership) {
        throw new NotFoundException('Conversation not found');
      }
    }

    return conv;
  }

  private async buildListWhere(
    actor: AuthenticatedAgent,
    query: ListConversationsDto,
  ): Promise<Prisma.ConversationWhereInput> {
    const isAdmin = actor.role === AgentRole.ADMIN;
    const assignee: AssigneeFilter = query.assignee ?? (isAdmin ? 'all' : 'me');
    const status = query.status ?? AGENT_VISIBLE_STATUSES;

    const where: Prisma.ConversationWhereInput = {
      status: { in: status },
    };

    if (query.channelId) {
      where.channelId = query.channelId;
    }

    if (!isAdmin) {
      const channelIds = await this.channels.getChannelIdsForAgent(actor.id);
      if (channelIds.length === 0) {
        // Agent has no channel access — an impossible filter returns nothing.
        return { id: { in: [] } };
      }
      if (query.channelId && !channelIds.includes(query.channelId)) {
        return { id: { in: [] } };
      }
      where.channelId = query.channelId ?? { in: channelIds };
    }

    if (assignee === 'me') {
      where.assignedAgentId = actor.id;
    } else if (assignee === 'unassigned') {
      where.assignedAgentId = null;
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
