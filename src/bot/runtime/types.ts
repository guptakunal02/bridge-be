import type { ConditionTree } from '../../rules/rule-evaluator.service';

/**
 * Type-narrowed views of a BotStep.config for each step type. The
 * runtime casts to these after switching on step.type; the config
 * validator has already vetted the shape at write time, so the casts
 * are safe by contract.
 */

export interface MessageStepConfig {
  text: string;
  nextStepId?: string;
}

export interface QuestionStepConfig {
  text: string;
  options: Array<{ label: string; nextStepId: string }>;
  timeoutSeconds?: number;
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
 * Every message the runtime asks the ChannelAdapter to send. Kept
 * intentionally small — templates / rich cards can come later once
 * the WhatsApp adapter is real.
 */
export type OutboundMessage =
  | { kind: 'text'; text: string }
  | {
      kind: 'question';
      text: string;
      options: Array<{ label: string }>;
    };
