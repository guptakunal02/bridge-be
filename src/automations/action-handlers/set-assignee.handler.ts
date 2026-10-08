import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../database/enums';
import { User } from '../../users/entities/user.entity';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/**
 * Idempotent assignee set. `userId: null` resolves to "send back to
 * the BOT queue" (i.e. unassigned, picker will re-route). Non-null
 * targets must be a non-BOT, non-deactivated user — otherwise the
 * action is skipped with a warn (rather than crashing the engine).
 */
@Injectable()
export class SetAssigneeHandler
  implements ActionHandler<Extract<Action, { type: 'set_assignee' }>>
{
  readonly type = 'set_assignee' as const;
  private readonly logger = new Logger(SetAssigneeHandler.name);

  constructor(
    @Inject(forwardRef(() => TicketsService))
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async execute(
    action: Extract<Action, { type: 'set_assignee' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    let targetId: string | null = action.userId;

    if (targetId === null) {
      const bot = await this.users.findOne({ where: { role: UserRole.BOT } });
      if (!bot) {
        this.logger.warn(
          `set_assignee(null) skipped on ticket=${ctx.ticket.id}: no BOT user`,
        );
        return;
      }
      targetId = bot.id;
    } else {
      const target = await this.users.findOne({
        where: { id: targetId },
        select: { id: true, role: true, deactivatedAt: true },
      });
      if (!target || target.deactivatedAt) {
        this.logger.warn(
          `set_assignee(${targetId}) skipped on ticket=${ctx.ticket.id}: user missing or deactivated`,
        );
        return;
      }
    }

    if (ctx.ticket.assigneeId === targetId) return;

    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `set_assignee skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.tickets.update(
        ctx.ticket.id,
        { assigneeId: targetId },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `set_assignee(${targetId}) failed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
