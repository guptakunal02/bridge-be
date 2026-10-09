import { Injectable, Logger } from '@nestjs/common';
import type { Action, ActionHandler } from './action';
import { AddTagHandler } from './action-handlers/add-tag.handler';
import { RemoveTagHandler } from './action-handlers/remove-tag.handler';
import { SetAssigneeHandler } from './action-handlers/set-assignee.handler';
import { SetStatusHandler } from './action-handlers/set-status.handler';
import { SetTeamHandler } from './action-handlers/set-team.handler';
import type { AutomationEventPayload } from './events';

/**
 * Resolves `action.type` → handler and executes. Handlers are
 * individual providers so each can own its own dependencies
 * (TicketsService, Repo, etc.) via standard DI, instead of a
 * manual registry.
 *
 * Dispatch failures are swallowed per-action — one bad action in
 * one case must never crash the rest of the engine's dispatch
 * loop. Handlers log their own errors; the dispatcher adds a
 * final backstop just in case a handler throws synchronously.
 */
@Injectable()
export class ActionDispatcher {
  private readonly logger = new Logger(ActionDispatcher.name);
  private readonly handlers: Map<Action['type'], ActionHandler>;

  constructor(
    addTag: AddTagHandler,
    removeTag: RemoveTagHandler,
    setStatus: SetStatusHandler,
    setAssignee: SetAssigneeHandler,
    setTeam: SetTeamHandler,
  ) {
    // Keys are hard-coded strings instead of reading `handler.type`
    // from the instance. The handlers participate in the
    // AutomationsModule ↔ TicketsModule forwardRef cycle, so Nest
    // may hand us the instance before its class-field initialisers
    // have populated `.type`. Historical bug (2026-10-08, every
    // automation silently no-op'd): "No handler for action.type=add_tag"
    // logged for every single rule because the Map ended up with
    // undefined keys. The strings here are the single source of
    // truth and MUST stay in sync with the Action discriminant
    // literals in action.ts.
    this.handlers = new Map<Action['type'], ActionHandler>([
      ['add_tag', addTag as ActionHandler],
      ['remove_tag', removeTag as ActionHandler],
      ['set_status', setStatus as ActionHandler],
      ['set_assignee', setAssignee as ActionHandler],
      ['set_team', setTeam as ActionHandler],
    ]);
  }

  async dispatch(action: Action, ctx: AutomationEventPayload): Promise<void> {
    const handler = this.handlers.get(action.type);
    if (!handler) {
      // A rule was persisted with an action type we don't support in
      // this build (older schema, pre-v2 revert, hand-edited row).
      // Log + skip — the rest of the rule's actions still run.
      this.logger.warn(
        `No handler for action.type=${action.type} (ticket=${ctx.ticket.id})`,
      );
      return;
    }
    try {
      await handler.execute(action, ctx);
    } catch (err) {
      this.logger.warn(
        `Action ${action.type} crashed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
