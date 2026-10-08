import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../database/enums';
import { User } from '../users/entities/user.entity';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';

/**
 * Resolves the BOT user as the "acting user" for automation-driven
 * writes. TicketsService.update requires an AuthenticatedUser so it
 * can stamp activity log rows with an actor id; automations
 * attribute their changes to BOT, which also matches the FE's
 * display convention for system-performed actions.
 *
 * Cached after first lookup — the BOT user is created at seed time
 * and never changes; re-querying on every action is wasted I/O.
 */
@Injectable()
export class AutomationSystemActor {
  private cached: AuthenticatedUser | null = null;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async resolve(): Promise<AuthenticatedUser | null> {
    if (this.cached) return this.cached;
    const bot = await this.users.findOne({ where: { role: UserRole.BOT } });
    if (!bot) return null;
    this.cached = {
      id: bot.id,
      email: bot.email ?? null,
      role: bot.role,
      isApproved: true,
    };
    return this.cached;
  }
}
