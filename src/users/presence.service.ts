import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserStatus } from '../database/enums';
import { User } from './entities/user.entity';

/**
 * Presence lifecycle events. Downstream modules (tickets) subscribe
 * via @OnEvent — keeps PresenceService free of feature-module
 * dependencies and dodges a circular import.
 */
export const PRESENCE_EVENTS = {
  /** Emitted only when the user transitioned to ONLINE from a non-ONLINE state. */
  CAME_ONLINE: 'presence.came_online',
  /** Emitted only when the user transitioned to EMERGENCY from a non-EMERGENCY state. */
  WENT_EMERGENCY: 'presence.went_emergency',
} as const;

export interface PresenceCameOnlineEvent {
  userId: string;
}

export interface PresenceWentEmergencyEvent {
  userId: string;
}

/**
 * Owns the "effective activity" model. Two operations:
 *
 *   setStatus(userId, next)
 *     Change status + stamp status_changed_at = NOW.
 *
 *   slideOnActivity(userId)
 *     Called from every ticket-mutating action. If the caller is
 *     already ONLINE, no-op. Otherwise slide status_changed_at
 *     forward so break/meeting duration reflects the last thing they
 *     actually did, not the moment they declared the state.
 *
 * Both operations are fire-and-forget from the service perspective —
 * they never throw for the caller unless setStatus can't find the
 * user (which is a real 404 the caller should surface).
 */
@Injectable()
export class PresenceService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly events: EventEmitter2,
  ) {}

  async setStatus(userId: string, next: UserStatus): Promise<User> {
    // Read the previous status first so we can detect transitions.
    // Only reads when the destination is ONLINE or EMERGENCY — the
    // two states that trigger downstream work. For other destinations
    // (MEETING / BREAK / OFFLINE) the extra round-trip would be
    // wasted so we skip it.
    const prev =
      next === UserStatus.ONLINE || next === UserStatus.EMERGENCY
        ? await this.users.findOne({
            where: { id: userId },
            select: { id: true, status: true },
          })
        : null;

    const now = new Date();
    const result = await this.users.update(
      { id: userId },
      { status: next, status_changed_at: now },
    );
    if (!result.affected) throw new NotFoundException('User not found');

    // Fire the "came online" event only on the actual transition.
    // Subscribers (TicketLifecycleService) will drain the queue up to
    // the agent's remaining capacity across their teams.
    if (
      next === UserStatus.ONLINE &&
      prev &&
      prev.status !== UserStatus.ONLINE
    ) {
      const payload: PresenceCameOnlineEvent = { userId };
      this.events.emit(PRESENCE_EVENTS.CAME_ONLINE, payload);
    }

    // Fire the "went emergency" event on the actual transition.
    // Subscribers (TicketLifecycleService) will re-queue the user's
    // OPEN tickets to BOT so another live teammate can pick them up —
    // the behaviour the enum docstring at database/enums.ts promises
    // but was never implemented until now.
    if (
      next === UserStatus.EMERGENCY &&
      prev &&
      prev.status !== UserStatus.EMERGENCY
    ) {
      const payload: PresenceWentEmergencyEvent = { userId };
      this.events.emit(PRESENCE_EVENTS.WENT_EMERGENCY, payload);
    }

    return this.users.findOneOrFail({ where: { id: userId } });
  }

  /**
   * Slide status_changed_at forward when the user is in a non-ONLINE
   * state — captures "effective break/meeting start" as the moment of
   * last work, per the presence design.
   *
   * Uses a single UPDATE ... WHERE status <> 'ONLINE' so the ONLINE
   * common case pays only one round trip and no write.
   */
  async slideOnActivity(userId: string): Promise<void> {
    await this.users
      .createQueryBuilder()
      .update(User)
      .set({ status_changed_at: () => 'NOW()' })
      .where('id = :id AND status <> :online', {
        id: userId,
        online: UserStatus.ONLINE,
      })
      .execute();
  }
}
