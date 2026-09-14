import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserRole, UserStatus } from '../database/enums';
import { User } from './entities/user.entity';

/**
 * Round-robin picker for auto-assignment. Given a team, returns the
 * team member (Online, non-paused-in-team, approved) whose
 * `last_assigned_at` is oldest, then stamps NOW on it so the next
 * call skips them. Falls back to BOT if:
 *   - the team itself has assignment_paused = true, or
 *   - no eligible member is available.
 */
@Injectable()
export class AssignmentPickerService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * Pick the next assignee inside the given team. Accepts an
   * EntityManager so callers running inside a transaction (e.g.
   * ingestInbound) share the connection — important so the
   * `last_assigned_at` write commits with the ticket insert.
   */
  async pickNextAssigneeForTeam(
    teamId: string,
    mgr?: EntityManager,
  ): Promise<string> {
    const repo: Repository<User> = mgr ? mgr.getRepository(User) : this.users;

    // Team-level pause first — if the whole team is paused, bounce
    // to BOT immediately without looking at membership.
    const pausedRows: Array<{ paused: boolean }> = await repo.manager.query(
      `SELECT assignment_paused AS paused FROM public.team WHERE id = $1`,
      [teamId],
    );
    const teamPaused = pausedRows[0]?.paused === true;

    if (!teamPaused) {
      const candidate = await repo
        .createQueryBuilder('u')
        .innerJoin(
          'team_member',
          'tm',
          'tm.user_id = u.id AND tm.paused_in_team = false',
        )
        .where('tm.team_id = :teamId', { teamId })
        .andWhere('u.role IN (:...roles)', {
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
        await repo.update(
          { id: candidate.id },
          { last_assigned_at: new Date() },
        );
        return candidate.id;
      }
    }

    // BOT is a first-class team member — the admin's toggle for it
    // controls whether it accepts fallback tickets in this team.
    // If BOT is paused here, ingest fails (caller catches, IMAP
    // retries later — forces the admin to un-pause).
    const botRows: Array<{ id: string; paused: boolean | null }> =
      await repo.manager.query(
        `SELECT u.id, tm.paused_in_team AS paused
         FROM public."user" u
         LEFT JOIN public.team_member tm
           ON tm.user_id = u.id AND tm.team_id = $1
         WHERE u.role = 'BOT' AND u."deactivatedAt" IS NULL
         LIMIT 1`,
        [teamId],
      );
    const bot = botRows[0];
    if (!bot) {
      throw new Error(
        'BOT user is not seeded and no live agents are available',
      );
    }
    if (bot.paused === true) {
      throw new Error(
        'No live agents and BOT is paused on this team — un-pause BOT or set an agent Online.',
      );
    }
    return bot.id;
  }
}
