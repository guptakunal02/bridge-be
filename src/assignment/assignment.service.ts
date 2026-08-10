import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AgentRole,
  AgentStatus,
  ConversationStatus,
  MessageDirection,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { ConversationsService } from '../conversations/conversations.service';
import {
  CONVERSATION_INCLUDE,
  toConversationResponse,
} from '../conversations/dto/conversation-response.dto';
import type {
  MessageCreatedEvent,
  PresenceUpdatedEvent,
} from '../realtime/events';
import { REALTIME_EVENTS } from '../realtime/events';

interface AutoAssignOutcome {
  agentId: string | null;
  changed: boolean;
}

/**
 * Auto-routes conversations to an available agent based on:
 *   1. If already assigned and assignee is ONLINE → keep (no reassignment on
 *      every message).
 *   2. Else pick the ONLINE agent with fewest open (OPEN|PENDING) conversations
 *      who has AgentChannel access to this channel. Tie-break by agent id for
 *      determinism.
 *   3. If no ONLINE agents → set status = PENDING, sit in the queue.
 *
 * Concurrency: wrapped in a transaction with SELECT ... FOR UPDATE on the
 * target conversation row so two parallel inbound messages for the same
 * conversation can't produce a double-assignment.
 *
 * Explicit product rule (from user): going OFFLINE never reassigns existing
 * conversations away from the agent. Only NEW inbound messages consider
 * candidates fresh.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);
  private readonly drainSoftCap = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly conversations: ConversationsService,
  ) {}

  async autoAssign(conversationId: string): Promise<string | null> {
    const outcome = await this.prisma.$transaction<AutoAssignOutcome>(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          {
            id: string;
            channelId: string;
            assignedAgentId: string | null;
            status: ConversationStatus;
          }[]
        >`SELECT id, "channelId", "assignedAgentId", status
        FROM "Conversation"
        WHERE id = ${conversationId}::uuid
        FOR UPDATE`;
        if (!row) return { agentId: null, changed: false };

        // Serialize assignment DECISIONS per channel so parallel inbounds
        // read a consistent load snapshot. Advisory lock is xact-scoped and
        // released automatically on commit. Different channels proceed in
        // parallel; same channel forms a queue.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.channelId}))`;

        if (row.assignedAgentId) {
          const assignee = await tx.agent.findUnique({
            where: { id: row.assignedAgentId },
            select: { status: true, deactivatedAt: true },
          });
          if (
            assignee &&
            assignee.deactivatedAt === null &&
            assignee.status === AgentStatus.ONLINE
          ) {
            return { agentId: row.assignedAgentId, changed: false };
          }
        }

        const pick = await this.pickLeastLoaded(tx, row.channelId);
        if (!pick) {
          if (row.status === ConversationStatus.PENDING) {
            return { agentId: null, changed: false };
          }
          await tx.conversation.update({
            where: { id: row.id },
            data: { status: ConversationStatus.PENDING },
          });
          return { agentId: null, changed: true };
        }

        if (pick === row.assignedAgentId) {
          return { agentId: pick, changed: false };
        }

        await tx.conversation.update({
          where: { id: row.id },
          data: {
            assignedAgentId: pick,
            status:
              row.status === ConversationStatus.PENDING
                ? ConversationStatus.OPEN
                : row.status,
          },
        });
        this.logger.log(
          {
            conversationId: row.id,
            agentId: pick,
            previous: row.assignedAgentId,
          },
          'auto-assigned',
        );
        return { agentId: pick, changed: true };
      },
    );

    // Emit AFTER the transaction commits so subscribers don't race an
    // uncommitted read.
    if (outcome.changed) {
      await this.emitFreshUpdate(conversationId);
    }
    return outcome.agentId;
  }

  /**
   * When an agent goes ONLINE, drain up to `drainSoftCap` PENDING conversations
   * from channels they have access to onto them (via the normal picker, so
   * least-loaded still wins).
   */
  async drainForAgent(agentId: string): Promise<void> {
    const membership = await this.prisma.agentChannel.findMany({
      where: { agentId },
      select: { channelId: true },
    });
    if (membership.length === 0) return;

    const pending = await this.prisma.conversation.findMany({
      where: {
        status: ConversationStatus.PENDING,
        channelId: { in: membership.map((m) => m.channelId) },
      },
      orderBy: [{ lastMessageAt: 'asc' }],
      take: this.drainSoftCap,
      select: { id: true },
    });

    for (const conv of pending) {
      await this.autoAssign(conv.id).catch((err: unknown) => {
        this.logger.warn(
          { err, conversationId: conv.id },
          'drain autoAssign failed',
        );
      });
    }
  }

  // ---- event listeners --------------------------------------------------

  @OnEvent(REALTIME_EVENTS.MessageCreated)
  async onMessageCreated(payload: MessageCreatedEvent): Promise<void> {
    if (payload.message.direction !== MessageDirection.INBOUND) return;
    try {
      await this.autoAssign(payload.conversationId);
    } catch (err) {
      this.logger.error(
        { err, conversationId: payload.conversationId },
        'autoAssign on inbound failed',
      );
    }
  }

  @OnEvent(REALTIME_EVENTS.PresenceUpdated)
  async onPresenceUpdated(payload: PresenceUpdatedEvent): Promise<void> {
    if (payload.status !== AgentStatus.ONLINE) return;
    try {
      await this.drainForAgent(payload.agentId);
    } catch (err) {
      this.logger.error({ err, agentId: payload.agentId }, 'drain failed');
    }
  }

  // ---- helpers ---------------------------------------------------------

  private async pickLeastLoaded(
    tx: Prisma.TransactionClient,
    channelId: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ agent_id: string; open_count: bigint }[]>`
      SELECT a.id AS agent_id,
             COUNT(c.id) AS open_count
      FROM "Agent" a
      INNER JOIN "AgentChannel" ac ON ac."agentId" = a.id
      LEFT JOIN "Conversation" c
        ON c."assignedAgentId" = a.id
       AND c.status IN (${ConversationStatus.OPEN}::"ConversationStatus",
                        ${ConversationStatus.PENDING}::"ConversationStatus")
      WHERE ac."channelId" = ${channelId}::uuid
        AND a.status = ${AgentStatus.ONLINE}::"AgentStatus"
        AND a."deactivatedAt" IS NULL
        AND a.role IN (${AgentRole.AGENT}::"AgentRole",
                       ${AgentRole.ADMIN}::"AgentRole")
      GROUP BY a.id
      ORDER BY open_count ASC, a.id ASC
      LIMIT 1`;
    return rows[0]?.agent_id ?? null;
  }

  private async emitFreshUpdate(conversationId: string): Promise<void> {
    const fresh = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: CONVERSATION_INCLUDE,
    });
    if (fresh) this.conversations.emitUpdated(toConversationResponse(fresh));
  }
}
