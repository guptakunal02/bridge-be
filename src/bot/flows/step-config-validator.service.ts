import { BadRequestException, Injectable } from '@nestjs/common';
import { BotStepType } from '../../database/enums';
import { RuleEvaluatorService } from '../../rules/rule-evaluator.service';
import { findFunction } from '../functions/registry';

/**
 * Validates a step's config JSONB against the shape declared for its
 * type. Used by:
 *   - flows service on create / update, to reject malformed configs
 *     before they hit the DB
 *   - runtime, so a config that survived an evolution of the schema
 *     is caught before it drives a real conversation
 *
 * Cross-reference validation (nextStepId points at a step that
 * actually exists in this flow) is the flows service's job — that
 * needs the full step set, which the validator doesn't know about.
 */
@Injectable()
export class StepConfigValidator {
  constructor(private readonly evaluator: RuleEvaluatorService) {}

  validate(type: BotStepType, rawConfig: unknown): void {
    const cfg = asObject(rawConfig);
    switch (type) {
      case BotStepType.MESSAGE:
        this.validateMessage(cfg);
        return;
      case BotStepType.QUESTION:
        this.validateQuestion(cfg);
        return;
      case BotStepType.FUNCTION:
        this.validateFunction(cfg);
        return;
      case BotStepType.BRANCH:
        this.validateBranch(cfg);
        return;
      case BotStepType.HANDOFF:
        this.validateHandoff(cfg);
        return;
    }
  }

  private validateMessage(cfg: Record<string, unknown>): void {
    if (typeof cfg.text !== 'string' || cfg.text.trim() === '') {
      throw new BadRequestException(
        'Message step: config.text must be a non-empty string',
      );
    }
    optionalUuid(cfg.nextStepId, 'Message step: config.nextStepId');
  }

  private validateQuestion(cfg: Record<string, unknown>): void {
    if (typeof cfg.text !== 'string' || cfg.text.trim() === '') {
      throw new BadRequestException(
        'Question step: config.text must be a non-empty string',
      );
    }
    if (!Array.isArray(cfg.options) || cfg.options.length === 0) {
      throw new BadRequestException(
        'Question step: config.options must be a non-empty array',
      );
    }
    cfg.options.forEach((opt: unknown, i) => {
      const o = asObject(opt);
      if (typeof o.label !== 'string' || o.label.trim() === '') {
        throw new BadRequestException(
          `Question step: option ${i}: label must be a non-empty string`,
        );
      }
      requireUuid(o.nextStepId, `Question step: option ${i}: nextStepId`);
    });
    if (cfg.timeoutSeconds !== undefined) {
      if (
        typeof cfg.timeoutSeconds !== 'number' ||
        !Number.isInteger(cfg.timeoutSeconds) ||
        cfg.timeoutSeconds < 1
      ) {
        throw new BadRequestException(
          'Question step: config.timeoutSeconds must be a positive integer',
        );
      }
    }
  }

  private validateFunction(cfg: Record<string, unknown>): void {
    if (typeof cfg.functionKey !== 'string') {
      throw new BadRequestException(
        'Function step: config.functionKey must be a string',
      );
    }
    const fn = findFunction(cfg.functionKey);
    if (!fn) {
      throw new BadRequestException(
        `Function step: no registered function "${cfg.functionKey}"`,
      );
    }
    if (
      cfg.inputs !== undefined &&
      (typeof cfg.inputs !== 'object' || Array.isArray(cfg.inputs))
    ) {
      throw new BadRequestException(
        'Function step: config.inputs must be an object mapping input names to values or `${variable}` refs',
      );
    }
    if (
      typeof cfg.outputVariable !== 'string' ||
      cfg.outputVariable.trim() === ''
    ) {
      throw new BadRequestException(
        'Function step: config.outputVariable must be a non-empty string (the session-variable key the function output lands under)',
      );
    }
    optionalUuid(cfg.nextStepId, 'Function step: config.nextStepId');
  }

  private validateBranch(cfg: Record<string, unknown>): void {
    if (!Array.isArray(cfg.branches) || cfg.branches.length === 0) {
      throw new BadRequestException(
        'Branch step: config.branches must be a non-empty array',
      );
    }
    const branches: unknown[] = cfg.branches;
    let sawDefault = false;
    branches.forEach((branch: unknown, i) => {
      const b = asObject(branch);
      requireUuid(b.nextStepId, `Branch step: branch ${i}: nextStepId`);
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
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException(`${label} must be a UUID when set`);
  }
}
