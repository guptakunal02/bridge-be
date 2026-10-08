import { Injectable, Logger } from '@nestjs/common';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/** Idempotent tag removal — short-circuits if the tag isn't present. */
@Injectable()
export class RemoveTagHandler
  implements ActionHandler<Extract<Action, { type: 'remove_tag' }>>
{
  readonly type = 'remove_tag' as const;
  private readonly logger = new Logger(RemoveTagHandler.name);

  constructor(
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
  ) {}

  async execute(
    action: Extract<Action, { type: 'remove_tag' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const tag = action.tagName.trim().toLowerCase();
    if (!tag) return;
    if (!ctx.ticket.tags.includes(tag)) return;
    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `remove_tag(${tag}) skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.tickets.update(
        ctx.ticket.id,
        { tags: ctx.ticket.tags.filter((t) => t !== tag) },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `remove_tag(${tag}) failed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
