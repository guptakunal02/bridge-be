import { BadRequestException, Injectable } from '@nestjs/common';
import { BotStepType } from '../../database/enums';
import { RuleEvaluatorService } from '../../rules/rule-evaluator.service';
import { findFunction } from '../functions/registry';

/**
 * Validates a step's config JSONB against the shape declared for its
 * type. Two modes:
 *
 *   strict = false  (default, used by flows CRUD):
 *     Structural-only. Tolerates scaffold configs — empty message
 *     text, empty options[], missing functionKey, empty branches[].
 *     A blank Add-step click should always succeed so the admin can
 *     fill it in.
 *
 *   strict = true   (used by the runtime before executing):
 *     Every required field must be present and non-empty. A missing
 *     text or functionKey at this point means the flow is unfinished
 *     and the runtime marks the session FAILED with a clear log.
 *
 * Both modes still reject *structural* garbage (wrong types on any
 * present field, unknown attributes in branch conditions, unknown
 * function keys) — those are always bugs regardless of when they
 * surface.
 *
 * Cross-reference validation (nextStepId points at a step that
 * actually exists in this flow) is the flows service's job.
 */
@Injectable()
export class StepConfigValidator {
  constructor(private readonly evaluator: RuleEvaluatorService) {}

  validate(type: BotStepType, rawConfig: unknown, strict = false): void {
    const cfg = asObject(rawConfig);
    switch (type) {
      case BotStepType.MESSAGE:
        this.validateMessage(cfg, strict);
        return;
      case BotStepType.FUNCTION:
        this.validateFunction(cfg, strict);
        return;
      case BotStepType.BRANCH:
        this.validateBranch(cfg, strict);
        return;
      case BotStepType.HANDOFF:
        this.validateHandoff(cfg);
        return;
    }
  }

  /**
   * Unified message validator. Handles both:
   *   - "send text and auto-advance" (options empty / missing)
   *   - "send text + reply buttons, wait for a pick" (options set)
   */
  private validateMessage(cfg: Record<string, unknown>, strict: boolean): void {
    if (cfg.text !== undefined && typeof cfg.text !== 'string') {
      throw new BadRequestException(
        'Message step: config.text must be a string',
      );
    }
    if (strict && (typeof cfg.text !== 'string' || cfg.text.trim() === '')) {
      throw new BadRequestException(
        'Message step: config.text must be a non-empty string',
      );
    }
    optionalUuid(cfg.nextStepId, 'Message step: config.nextStepId');

    if (cfg.options !== undefined && !Array.isArray(cfg.options)) {
      throw new BadRequestException(
        'Message step: config.options must be an array when set',
      );
    }
    if (Array.isArray(cfg.options)) {
      cfg.options.forEach((opt: unknown, i) => {
        const o = asObject(opt);
        if (o.label !== undefined && typeof o.label !== 'string') {
          throw new BadRequestException(
            `Message step: option ${i}: label must be a string`,
          );
        }
        if (strict && (typeof o.label !== 'string' || o.label.trim() === '')) {
          throw new BadRequestException(
            `Message step: option ${i}: label must be a non-empty string`,
          );
        }
        if (strict) {
          requireUuid(o.nextStepId, `Message step: option ${i}: nextStepId`);
        } else {
          optionalUuid(o.nextStepId, `Message step: option ${i}: nextStepId`);
        }
      });
    }
    if (cfg.timeoutSeconds !== undefined) {
      if (
        typeof cfg.timeoutSeconds !== 'number' ||
        !Number.isInteger(cfg.timeoutSeconds) ||
        cfg.timeoutSeconds < 1
      ) {
        throw new BadRequestException(
          'Message step: config.timeoutSeconds must be a positive integer',
        );
      }
    }
  }

  private validateFunction(
    cfg: Record<string, unknown>,
    strict: boolean,
  ): void {
    if (cfg.functionKey !== undefined) {
      if (typeof cfg.functionKey !== 'string') {
        throw new BadRequestException(
          'Function step: config.functionKey must be a string',
        );
      }
      if (cfg.functionKey !== '' && !findFunction(cfg.functionKey)) {
        throw new BadRequestException(
          `Function step: no registered function "${cfg.functionKey}"`,
        );
      }
    }
    if (
      strict &&
      (typeof cfg.functionKey !== 'string' || cfg.functionKey === '')
    ) {
      throw new BadRequestException(
        'Function step: config.functionKey is required — pick a function.',
      );
    }
    if (
      cfg.inputs !== undefined &&
      (typeof cfg.inputs !== 'object' ||
        cfg.inputs === null ||
        Array.isArray(cfg.inputs))
    ) {
      throw new BadRequestException(
        'Function step: config.inputs must be an object mapping input names to values or `${variable}` refs',
      );
    }
    if (
      cfg.outputVariable !== undefined &&
      typeof cfg.outputVariable !== 'string'
    ) {
      throw new BadRequestException(
        'Function step: config.outputVariable must be a string',
      );
    }
    if (
      strict &&
      (typeof cfg.outputVariable !== 'string' ||
        cfg.outputVariable.trim() === '')
    ) {
      throw new BadRequestException(
        'Function step: config.outputVariable is required — pick a session-variable key to store the output under.',
      );
    }
    optionalUuid(cfg.nextStepId, 'Function step: config.nextStepId');
  }

  private validateBranch(cfg: Record<string, unknown>, strict: boolean): void {
    if (cfg.branches !== undefined && !Array.isArray(cfg.branches)) {
      throw new BadRequestException(
        'Branch step: config.branches must be an array when set',
      );
    }
    if (strict && (!Array.isArray(cfg.branches) || cfg.branches.length === 0)) {
      throw new BadRequestException(
        'Branch step: config.branches must be a non-empty array',
      );
    }
    if (!Array.isArray(cfg.branches)) return;

    const branches: unknown[] = cfg.branches;
    let sawDefault = false;
    branches.forEach((branch: unknown, i) => {
      const b = asObject(branch);
      if (strict) {
        requireUuid(b.nextStepId, `Branch step: branch ${i}: nextStepId`);
      } else {
        optionalUuid(b.nextStepId, `Branch step: branch ${i}: nextStepId`);
      }
      if (b.conditions === undefined || b.conditions === null) {
        if (sawDefault) {
          throw new BadRequestException(
            'Branch step: only one default (no-conditions) branch is allowed, and it must be last',
          );
        }
        if (i !== branches.length - 1) {
          throw new BadRequestException(
            'Branch step: the default (no-conditions) branch must be the last one',
          );
        }
        sawDefault = true;
        return;
      }
      try {
        this.evaluator.validate(b.conditions);
      } catch (err) {
        throw new BadRequestException(
          `Branch step: branch ${i}: ${(err as Error).message}`,
        );
      }
    });
  }

  private validateHandoff(cfg: Record<string, unknown>): void {
    optionalUuid(cfg.teamId, 'Handoff step: config.teamId');
    if (cfg.note !== undefined && typeof cfg.note !== 'string') {
      throw new BadRequestException(
        'Handoff step: config.note must be a string when set',
      );
    }
  }

  /**
   * Validate a trigger conditions tree. Same shape as rules. Null
   * / missing means "no gate on the trigger" and is allowed.
   */
  validateTriggerConditions(tree: unknown): void {
    if (tree === null || tree === undefined) return;
    this.evaluator.validate(tree);
  }
}

/* ---- helpers -------------------------------------------------- */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Config must be an object');
  }
  return value as Record<string, unknown>;
}

function requireUuid(value: unknown, label: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException(`${label} must be a UUID`);
  }
}

function optionalUuid(value: unknown, label: string): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException(`${label} must be a UUID when set`);
  }
}
