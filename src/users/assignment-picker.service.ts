import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { UserRole, UserStatus } from '../database/enums';
import { User } from './entities/user.entity';

/**
 * Round-robin picker for auto-assignment. Given a set of eligible
 * users, returns the one that hasn't been assigned to in the longest
 * time (null `last_assigned_at` counts as the oldest possible), then
 * stamps their `last_assigned_at = NOW` so the next call skips them.
 *
 * Currently ignores team scoping — Wave 2 adds a per-team variant.
 * MVP eligibility rule: role = MEMBER or ADMIN, status = ONLINE, not
 * deactivated, is approved.
 */
@Injectable()
export class AssignmentPickerService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * Pick the next assignee for a new ticket. Returns the BOT user id
   * when no live agents are available so the ticket lands in the
   * "unassigned" queue for admins to route manually.
   *
   * Accepts an optional EntityManager so callers running inside a
   * transaction (e.g. ingestInbound) can share the connection —
   * important so the `last_assigned_at` write commits alongside the
   * ticket insert.
   */
  async pickNextAssignee(mgr?: EntityManager): Promise<string> {
    const repo: Repository<User> = mgr ? mgr.getRepository(User) : this.users;

    const candidate = await repo
      .createQueryBuilder('u')
      .where('u.role IN (:...roles)', {
        roles: [UserRole.MEMBER, UserRole.ADMIN],
      })
      .andWhere('u.status = :online', { online: UserStatus.ONLINE })
      .andWhere('u.isApproved = true')
      .andWhere('u.deactivatedAt IS NULL')
      .orderBy('u.last_assigned_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('u.createdAt', 'ASC')
      .limit(1)
      .getOne();

    if (candidate) {
      await repo.update({ id: candidate.id }, { last_assigned_at: new Date() });
      return candidate.id;
    }

    const bot = await repo.findOne({
      where: { role: UserRole.BOT, deactivatedAt: IsNull() },
    });
    if (!bot) {
      // Fall through to the caller — old code path relies on this
      // sentinel state to throw a friendlier error.
      throw new Error('BOT user is not seeded and no live agents are Online');
    }
    return bot.id;
  }
}
