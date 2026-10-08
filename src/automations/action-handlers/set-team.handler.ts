import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from '../../teams/entities/team.entity';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/** Idempotent team set. Rejects unknown team ids with a warn. */
@Injectable()
export class SetTeamHandler
  implements ActionHandler<Extract<Action, { type: 'set_team' }>>
{
  readonly type = 'set_team' as const;
  private readonly logger = new Logger(SetTeamHandler.name);

  constructor(
    @Inject(forwardRef(() => TicketsService))
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
    @InjectRepository(Team) private readonly teams: Repository<Team>,
  ) {}

  async execute(
    action: Extract<Action, { type: 'set_team' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const team = await this.teams.findOne({
      where: { id: action.teamId },
      select: { id: true },
    });
    if (!team) {
      this.logger.warn(
        `set_team(${action.teamId}) skipped on ticket=${ctx.ticket.id}: team not found`,
      );
      return;
    }
    if (ctx.ticket.teamId === action.teamId) return;

    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `set_team skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.tickets.update(
        ctx.ticket.id,
        { teamId: action.teamId },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `set_team(${action.teamId}) failed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
