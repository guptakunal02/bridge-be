import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceUpdatedEvent, REALTIME_EVENTS } from '../realtime/events';

const DISCONNECT_GRACE_MS = 15_000;

/**
 * Tracks live Socket.IO connections per user so we can drive User.status
 * transitions. Rules (see plan for rationale):
 *
 *   - First socket connects for a user whose status is OFFLINE → ONLINE.
 *     If the user explicitly set AWAY, we leave AWAY in place across
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

  async onSocketConnect(userId: string, socketId: string): Promise<void> {
    const pending = this.pendingOffline.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOffline.delete(userId);
    }

    let sockets = this.liveSockets.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.liveSockets.set(userId, sockets);
    }
    const wasEmpty = sockets.size === 0;
    sockets.add(socketId);

    if (wasEmpty) {
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true },
      });
      if (current?.status === UserStatus.OFFLINE) {
        await this.applyStatus(userId, UserStatus.ONLINE);
      } else {
        // Even without a status flip, bump lastSeenAt.
        await this.bumpLastSeen(userId);
      }
    }
  }

  onSocketDisconnect(userId: string, socketId: string): void {
    const sockets = this.liveSockets.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size > 0) return;

    this.liveSockets.delete(userId);
    const timer = setTimeout(() => {
      this.pendingOffline.delete(userId);
      // If they reconnected inside the window, this map won't have them.
      if (this.liveSockets.has(userId)) return;
      void this.applyStatus(userId, UserStatus.OFFLINE).catch(
        (err: unknown) => {
          this.logger.error(
            { err, userId },
            'Failed to mark user OFFLINE after grace',
          );
        },
      );
    }, DISCONNECT_GRACE_MS);
    this.pendingOffline.set(userId, timer);
  }

  setStatus(userId: string, status: UserStatus): Promise<void> {
    // Explicit set overrides any pending offline transition.
    const pending = this.pendingOffline.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.pendingOffline.delete(userId);
    }
    return this.applyStatus(userId, status);
  }

  isTrackedOnline(userId: string): boolean {
    return (this.liveSockets.get(userId)?.size ?? 0) > 0;
  }

  private async applyStatus(
    userId: string,
    status: UserStatus,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status, lastSeenAt: now },
      select: { id: true, status: true, lastSeenAt: true },
    });
    const event: PresenceUpdatedEvent = {
      userId: updated.id,
      status: updated.status,
      lastSeenAt: updated.lastSeenAt?.toISOString() ?? null,
    };
    this.events.emit(REALTIME_EVENTS.PresenceUpdated, event);
  }

  private async bumpLastSeen(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
    });
  }
}
