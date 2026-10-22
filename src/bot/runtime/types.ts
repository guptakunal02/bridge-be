import type { ConditionTree } from '../../rules/rule-evaluator.service';

/**
 * Type-narrowed views of a BotStep.config for each step type. The
 * runtime casts to these after switching on step.type; the config
 * validator has already vetted the shape at write time, so the casts
 * are safe by contract.
 */

/**
 * A message step. `options` is what decides whether the runtime
 * blocks:
 *   options empty / missing → send `text`, advance via nextStepId
 *                             (or the linear next step at position+1).
 *   options[] present       → send text + buttons, wait for the
 *                             customer to reply with one of the
 *                             labels, route to that option's
 *                             nextStepId.
 */
export interface MessageStepConfig {
  text: string;
  options?: Array<{ label: string; nextStepId: string }>;
  timeoutSeconds?: number;
  nextStepId?: string;
}

export interface FunctionStepConfig {
  functionKey: string;
  inputs?: Record<string, unknown>;
  outputVariable: string;
  /**
   * Per-outcome routing. Keys are the function's declared outcome
   * keys (e.g. 'found', 'not_found'); value is the stepId to advance
   * to when the handler returns that outcome. Unwired outcome at
   * runtime → session ends with a warn log. `nextStepId` is kept as
   * a legacy escape hatch for pre-outcomes rows + as a fallback when
   * every outcome resolves to the same next step (admin may want to
   * just wire one default).
   */
  onOutcome?: Record<string, string>;
  nextStepId?: string;
}

export interface BranchStepConfig {
  branches: Array<{
    conditions?: ConditionTree;
    nextStepId: string;
  }>;
}

export interface HandoffStepConfig {
  teamId?: string;
  note?: string;
}

/**
 * A delay step. The runtime stores `wake_at = now + amountSeconds` on
 * the session, points `current_step_id` at the next step, then
 * returns. A periodic sweep in BotRuntimeService finds sleeping
 * sessions whose `wake_at` has passed and resumes them. Terminals are
 * never set — the delay doesn't finish the flow, it just pauses it.
 *
 * `amountSeconds` is the single scalar for admin simplicity; the FE
 * exposes a (number, unit) pair but persists as seconds so the
 * runtime never has to interpret units.
 */
export interface DelayStepConfig {
  amountSeconds: number;
  nextStepId?: string;
}

/**
 * Terminal step that marks the ticket RESOLVED. Mirrors Handoff in
 * shape but with a close-out intent instead of a hand-to-queue one.
 *
 * `tag` (optional) is applied to the ticket BEFORE the resolve so
 * admins can tag flow-closed tickets (e.g. "bot-resolved",
 * "tracking-shared") for reporting + to satisfy the "require tag to
 * resolve" workspace setting without forcing the admin to add a
 * separate TagStep type. Idempotent — if the tag is already on the
 * ticket, we don't duplicate.
 *
 * `note` (optional) lands in the ticket activity log alongside the
 * MARKED_RESOLVED event so the trail shows WHY the bot resolved
 * ("Customer confirmed tracking shared", "Return initiated", etc.).
 */
export interface ResolveStepConfig {
  tag?: string;
  note?: string;
}

/**
 * Every message the runtime asks the ChannelAdapter to send. Options
 * are optional — a message without them is pure text; with them it's
 * text plus a button list the channel adapter renders however its
 * medium allows (WhatsApp: quick-reply buttons; email: numbered list;
 * SMS: plain enumeration).
 */
export interface OutboundMessage {
  text: string;
  options?: Array<{ label: string }>;
}
