import type { TicketStatus } from '../database/enums';
import type { AutomationEventPayload } from './events';

/**
 * V1 action types. Each handler mutates ticket state and MUST be
 * idempotent — if the target state is already in effect (tag
 * already present, status already set), the handler short-circuits
 * without a DB write. That short-circuit is what breaks event
 * cascades (see events.ts: no state write → no follow-on event
 * emitted → no loop).
 */
export type ActionType =
  | 'add_tag'
  | 'remove_tag'
  | 'set_status'
  | 'set_assignee'
  | 'set_team';

export type Action =
  | { type: 'add_tag'; tagName: string }
  | { type: 'remove_tag'; tagName: string }
  | { type: 'set_status'; status: TicketStatus }
  | {
      type: 'set_assignee';
      /** User id to assign to. `null` sends the ticket back to the
       *  BOT queue (i.e. "unassign"). */
      userId: string | null;
    }
  | { type: 'set_team'; teamId: string };

/**
 * Contract every action handler implements. Receives the dispatched
 * event (so the handler can see payload + ticket snapshot) and the
 * typed action payload. Handlers log their own outcomes; the
 * dispatcher just wires action.type → handler.
 */
export interface ActionHandler<A extends Action = Action> {
  readonly type: A['type'];
  execute(action: A, ctx: AutomationEventPayload): Promise<void>;
}
