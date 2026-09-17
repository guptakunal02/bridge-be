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
