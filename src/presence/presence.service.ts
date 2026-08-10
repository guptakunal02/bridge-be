import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceUpdatedEvent, REALTIME_EVENTS } from '../realtime/events';

const DISCONNECT_GRACE_MS = 15_000;

/**
 * Tracks live Socket.IO connections per agent so we can drive Agent.status
 * transitions. Rules (see plan for rationale):
 *
 *   - First socket connects for an agent whose status is OFFLINE → ONLINE.
 *     If the agent explicitly set AWAY, we leave AWAY in place across
 *     reconnects (a page refresh must not silently flip them back).
 *   - Last socket disconnects → 15s grace → OFFLINE. Explicit AWAY loses to
 *     an actual disconnect: if they're gone, they're gone.
 *   - Explicit setStatus (via REST or WS) always wins, no grace.
 *
 * In-memory socket tracking is intentional. Multi-instance deployments will
 * need Redis-backed tracking; single-instance V1 doesn't yet.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly liveSockets = new Map<string, Set<string>>();
  private readonly pendingOffline = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.pendingOffline.values()) clearTimeout(timer);
    this.pendingOffline.clear();
    this.liveSockets.clear();
  }

  async onSocketConnect(agentId: string, socketId: string): Promise<void> {
    const pending = this.pendingOffline.get(agentId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOffline.delete(agentId);
    }

    let sockets = this.liveSockets.get(agentId);
    if (!sockets) {
      sockets = new Set();
      this.liveSockets.set(agentId, sockets);
    }
    const wasEmpty = sockets.size === 0;
    sockets.add(socketId);

    if (wasEmpty) {
      const current = await this.prisma.agent.findUnique({
        where: { id: agentId },
        select: { status: true },
      });
      if (current?.status === AgentStatus.OFFLINE) {
        await this.applyStatus(agentId, AgentStatus.ONLINE);
      } else {
        // Even without a status flip, bump lastSeenAt.
        await this.bumpLastSeen(agentId);
      }
    }
  }

  onSocketDisconnect(agentId: string, socketId: string): void {
    const sockets = this.liveSockets.get(agentId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size > 0) return;

    this.liveSockets.delete(agentId);
    const timer = setTimeout(() => {
      this.pendingOffline.delete(agentId);
      // If they reconnected inside the window, this map won't have them.
      if (this.liveSockets.has(agentId)) return;
      void this.applyStatus(agentId, AgentStatus.OFFLINE).catch(
        (err: unknown) => {
          this.logger.error(
            { err, agentId },
            'Failed to mark agent OFFLINE after grace',
          );
        },
      );
    }, DISCONNECT_GRACE_MS);
    this.pendingOffline.set(agentId, timer);
  }

  setStatus(agentId: string, status: AgentStatus): Promise<void> {
    // Explicit set overrides any pending offline transition.
    const pending = this.pendingOffline.get(agentId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOffline.delete(agentId);
    }
    return this.applyStatus(agentId, status);
  }

  isTrackedOnline(agentId: string): boolean {
    return (this.liveSockets.get(agentId)?.size ?? 0) > 0;
  }

  private async applyStatus(
    agentId: string,
    status: AgentStatus,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.agent.update({
      where: { id: agentId },
      data: { status, lastSeenAt: now },
      select: { id: true, status: true, lastSeenAt: true },
    });
    const event: PresenceUpdatedEvent = {
      agentId: updated.id,
      status: updated.status,
      lastSeenAt: updated.lastSeenAt?.toISOString() ?? null,
    };
    this.events.emit(REALTIME_EVENTS.PresenceUpdated, event);
  }

  private async bumpLastSeen(agentId: string): Promise<void> {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { lastSeenAt: new Date() },
    });
  }
}
