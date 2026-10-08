import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/**
 * Idempotent tag add. Tag mutation is set-semantics on
 * TicketsService.update, so we compute the next set from the
 * current snapshot. If the tag's already present, we skip the
 * update entirely — that short-circuit is what breaks cascading
 * tag.applied events in event-driven rule chains.
 */
@Injectable()
export class AddTagHandler
  implements ActionHandler<Extract<Action, { type: 'add_tag' }>>
{
  readonly type = 'add_tag' as const;
  private readonly logger = new Logger(AddTagHandler.name);

  constructor(
    // forwardRef — TicketsModule and AutomationsModule import each
    // other (tag mutations emit automation events; automation actions
    // call back into TicketsService.update). Without this inject
    // Nest resolves TicketsService as undefined and dies at boot.
    @Inject(forwardRef(() => TicketsService))
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
  ) {}

  async execute(
    action: Extract<Action, { type: 'add_tag' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const tag = action.tagName.trim().toLowerCase();
    if (!tag) return;
    if (ctx.ticket.tags.includes(tag)) return;
    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `add_tag(${tag}) skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.tickets.update(
        ctx.ticket.id,
        { tags: [...ctx.ticket.tags, tag] },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `add_tag(${tag}) failed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
