import { Injectable, Logger } from '@nestjs/common';
import { TicketStatus } from '../../database/enums';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/**
 * Idempotent status set. V1 only supports non-timed transitions
 * (OPEN, RESOLVED). WAITING / IN_FOLLOWUP both need a `resumeAt`
 * duration which the automation author would have to pick in the
 * rule UI — doable, just not shipping in V1. Attempts to set
 * either are rejected with a warn so a badly-authored rule can't
 * silently mint a status with no timer.
 */
@Injectable()
export class SetStatusHandler
  implements ActionHandler<Extract<Action, { type: 'set_status' }>>
{
  readonly type = 'set_status' as const;
  private readonly logger = new Logger(SetStatusHandler.name);

  constructor(
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
  ) {}

  async execute(
    action: Extract<Action, { type: 'set_status' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    if (
      action.status !== TicketStatus.OPEN &&
      action.status !== TicketStatus.RESOLVED
    ) {
      this.logger.warn(
        `set_status(${action.status}) on ticket=${ctx.ticket.id} rejected: V1 supports only OPEN / RESOLVED`,
      );
      return;
    }
    if (ctx.ticket.status === action.status) return;
    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `set_status(${action.status}) skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.tickets.update(
        ctx.ticket.id,
        { status: action.status },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `set_status(${action.status}) failed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
