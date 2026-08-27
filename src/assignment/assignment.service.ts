import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConversationStatus,
  MessageDirection,
  Prisma,
  UserRole,
  UserStatus,
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
  userId: string | null;
  changed: boolean;
}

/**
 * Auto-routes conversations to an available user based on:
 *   1. If already assigned and assignee is ONLINE → keep (no reassignment on
 *      every message).
 *   2. Else pick the ONLINE user with fewest open (OPEN|PENDING) conversations
 *      who has UserChannel access to this channel. Tie-break by user id for
 *      determinism.
 *   3. If no ONLINE users → set status = PENDING, sit in the queue.
 *
 * Concurrency: wrapped in a transaction with SELECT ... FOR UPDATE on the
 * target conversation row so two parallel inbound messages for the same
 * conversation can't produce a double-assignment.
 *
 * Explicit product rule (from user): going OFFLINE never reassigns existing
 * conversations away from the user. Only NEW inbound messages consider
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
            assignedUserId: string | null;
            status: ConversationStatus;
          }[]
        >`SELECT id, "channelId", "assignedUserId", status
        FROM "Conversation"
        WHERE id = ${conversationId}::uuid
        FOR UPDATE`;
        if (!row) return { userId: null, changed: false };

        // Serialize assignment DECISIONS per channel so parallel inbounds
        // read a consistent load snapshot. Advisory lock is xact-scoped and
        // released automatically on commit. Different channels proceed in
        // parallel; same channel forms a queue.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.channelId}))`;

        if (row.assignedUserId) {
          const assignee = await tx.user.findUnique({
            where: { id: row.assignedUserId },
            select: { status: true, deactivatedAt: true },
          });
          if (
            assignee &&
            assignee.deactivatedAt === null &&
            assignee.status === UserStatus.ONLINE
          ) {
            return { userId: row.assignedUserId, changed: false };
          }
        }

        const pick = await this.pickLeastLoaded(tx, row.channelId);
        if (!pick) {
          if (row.status === ConversationStatus.PENDING) {
            return { userId: null, changed: false };
          }
          await tx.conversation.update({
            where: { id: row.id },
            data: { status: ConversationStatus.PENDING },
          });
          return { userId: null, changed: true };
        }

        if (pick === row.assignedUserId) {
          return { userId: pick, changed: false };
        }

        await tx.conversation.update({
          where: { id: row.id },
          data: {
            assignedUserId: pick,
            status:
              row.status === ConversationStatus.PENDING
                ? ConversationStatus.OPEN
                : row.status,
          },
        });
        this.logger.log(
          {
            conversationId: row.id,
            userId: pick,
            previous: row.assignedUserId,
          },
          'auto-assigned',
        );
        return { userId: pick, changed: true };
      },
    );

    // Emit AFTER the transaction commits so subscribers don't race an
    // uncommitted read.
    if (outcome.changed) {
      await this.emitFreshUpdate(conversationId);
    }
    return outcome.userId;
  }

  /**
   * When a user goes ONLINE, drain up to `drainSoftCap` PENDING conversations
   * from channels they have access to onto them (via the normal picker, so
   * least-loaded still wins).
   */
  async drainForUser(userId: string): Promise<void> {
    const membership = await this.prisma.userChannel.findMany({
      where: { userId },
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
    if (payload.status !== UserStatus.ONLINE) return;
    try {
      await this.drainForUser(payload.userId);
    } catch (err) {
      this.logger.error({ err, userId: payload.userId }, 'drain failed');
    }
  }

  // ---- helpers ---------------------------------------------------------

  private async pickLeastLoaded(
    tx: Prisma.TransactionClient,
    channelId: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ user_id: string; open_count: bigint }[]>`
      SELECT u.id AS user_id,
             COUNT(c.id) AS open_count
      FROM "User" u
      INNER JOIN "UserChannel" uc ON uc."userId" = u.id
      LEFT JOIN "Conversation" c
        ON c."assignedUserId" = u.id
       AND c.status IN (${ConversationStatus.OPEN}::"ConversationStatus",
                        ${ConversationStatus.PENDING}::"ConversationStatus")
      WHERE uc."channelId" = ${channelId}::uuid
        AND u.status = ${UserStatus.ONLINE}::"UserStatus"
        AND u."deactivatedAt" IS NULL
        AND u.role IN (${UserRole.MEMBER}::"UserRole",
                       ${UserRole.ADMIN}::"UserRole")
      GROUP BY u.id
      ORDER BY open_count ASC, u.id ASC
      LIMIT 1`;
    return rows[0]?.user_id ?? null;
  }

  private async emitFreshUpdate(conversationId: string): Promise<void> {
    const fresh = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: CONVERSATION_INCLUDE,
    });
    if (fresh) this.conversations.emitUpdated(toConversationResponse(fresh));
  }
}
