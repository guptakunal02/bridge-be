import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserStatus } from '../database/enums';
import { User } from './entities/user.entity';

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
  ) {}

  async setStatus(userId: string, next: UserStatus): Promise<User> {
    const now = new Date();
    const result = await this.users.update(
      { id: userId },
      { status: next, status_changed_at: now },
    );
    if (!result.affected) throw new NotFoundException('User not found');
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
