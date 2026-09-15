import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AttributeDefinition,
  ATTRIBUTES,
  findAttribute,
  Operator,
} from './attributes';

/**
 * Values extracted from a candidate ticket, keyed by attribute id.
 * The routing engine builds one of these per ingest before evaluating
 * rules; the /rules/:id/test endpoint accepts a hand-crafted one.
 */
export type TicketContext = Record<string, unknown>;

export interface Condition {
  attribute: string;
  operator: Operator;
  value: unknown;
}

export interface ConditionGroup {
  conditions: Condition[];
}

export interface ConditionTree {
  groups: ConditionGroup[];
}

@Injectable()
export class RuleEvaluatorService {
  /**
   * Structural + type validation. Throws BadRequestException with a
   * clear message when the tree is malformed; returns silently on
   * success. Called on every create/update so bad rules never persist.
   */
  validate(tree: unknown): asserts tree is ConditionTree {
    if (!tree || typeof tree !== 'object') {
      throw new BadRequestException('Rule must be an object');
    }
    const t = tree as { groups?: unknown };
    if (!Array.isArray(t.groups)) {
      throw new BadRequestException('Rule.groups must be an array');
    }
    if (t.groups.length === 0) {
      throw new BadRequestException('Rule needs at least one group');
    }
    t.groups.forEach((group: unknown, gi: number) => {
      if (!group || typeof group !== 'object') {
        throw new BadRequestException(`Group ${gi} must be an object`);
      }
      const g = group as { conditions?: unknown };
      if (!Array.isArray(g.conditions) || g.conditions.length === 0) {
        throw new BadRequestException(
          `Group ${gi} needs at least one condition`,
        );
      }
      g.conditions.forEach((c: unknown, ci: number) => {
        this.validateCondition(c, gi, ci);
      });
    });
  }

  private validateCondition(raw: unknown, gi: number, ci: number): void {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(
        `Group ${gi} condition ${ci} must be an object`,
      );
    }
    const c = raw as {
      attribute?: unknown;
      operator?: unknown;
      value?: unknown;
    };
    if (typeof c.attribute !== 'string') {
      throw new BadRequestException(
        `Group ${gi} condition ${ci}: attribute must be a string`,
      );
    }
    const attr = findAttribute(c.attribute);
    if (!attr) {
      throw new BadRequestException(
        `Group ${gi} condition ${ci}: unknown attribute "${c.attribute}"`,
      );
    }
    if (typeof c.operator !== 'string') {
      throw new BadRequestException(
        `Group ${gi} condition ${ci}: operator must be a string`,
      );
    }
    if (!attr.operators.includes(c.operator as Operator)) {
      throw new BadRequestException(
        `Group ${gi} condition ${ci}: operator "${c.operator}" is not allowed for attribute "${attr.key}"`,
      );
    }
    this.validateValue(c.value, attr, gi, ci);
  }

  private validateValue(
    value: unknown,
    attr: AttributeDefinition,
    gi: number,
    ci: number,
  ): void {
    const where = `Group ${gi} condition ${ci}`;
    switch (attr.type) {
      case 'integer':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new BadRequestException(`${where}: value must be a number`);
        }
        if (attr.min !== undefined && value < attr.min) {
          throw new BadRequestException(
            `${where}: value must be >= ${attr.min}`,
          );
        }
        if (attr.max !== undefined && value > attr.max) {
          throw new BadRequestException(
            `${where}: value must be <= ${attr.max}`,
          );
        }
        break;
      case 'enum':
        if (typeof value !== 'string') {
          throw new BadRequestException(`${where}: value must be a string`);
        }
        if (attr.enumValues && !attr.enumValues.includes(value)) {
          throw new BadRequestException(
            `${where}: value must be one of ${attr.enumValues.join(', ')}`,
          );
        }
        break;
      case 'string':
        if (typeof value !== 'string') {
          throw new BadRequestException(`${where}: value must be a string`);
        }
        break;
      case 'string_array':
        // contains / not_contains take a single string; contains_any takes an array.
        // Both are valid — the evaluator picks based on the operator.
        if (
          typeof value !== 'string' &&
          !(Array.isArray(value) && value.every((v) => typeof v === 'string'))
        ) {
          throw new BadRequestException(
            `${where}: value must be a string or array of strings`,
          );
        }
        break;
    }
  }

  /**
   * Evaluate a validated tree against a context. Groups OR'd,
   * conditions within a group AND'd. Missing context values are
   * treated as "no match" — an evaluator that throws on missing keys
   * would make rules fragile as attributes are added over time.
   */
  evaluate(tree: ConditionTree, ctx: TicketContext): boolean {
    return tree.groups.some((group) =>
      group.conditions.every((cond) => this.evalCondition(cond, ctx)),
    );
  }

  private evalCondition(cond: Condition, ctx: TicketContext): boolean {
    const actual = ctx[cond.attribute];
    if (actual === undefined || actual === null) return false;
    switch (cond.operator) {
      case 'eq':
        return actual === cond.value;
      case 'neq':
        return actual !== cond.value;
      case 'gt':
        return (
          typeof actual === 'number' &&
          typeof cond.value === 'number' &&
          actual > cond.value
        );
      case 'gte':
        return (
          typeof actual === 'number' &&
          typeof cond.value === 'number' &&
          actual >= cond.value
        );
      case 'lt':
        return (
          typeof actual === 'number' &&
          typeof cond.value === 'number' &&
          actual < cond.value
        );
      case 'lte':
        return (
          typeof actual === 'number' &&
          typeof cond.value === 'number' &&
          actual <= cond.value
        );
      case 'contains':
        if (Array.isArray(actual)) {
          return actual.includes(cond.value);
        }
        return (
          typeof actual === 'string' &&
          typeof cond.value === 'string' &&
          actual.toLowerCase().includes(cond.value.toLowerCase())
        );
      case 'not_contains':
        if (Array.isArray(actual)) {
          return !actual.includes(cond.value);
        }
        return (
          typeof actual === 'string' &&
          typeof cond.value === 'string' &&
          !actual.toLowerCase().includes(cond.value.toLowerCase())
        );
      case 'starts_with':
        return (
          typeof actual === 'string' &&
          typeof cond.value === 'string' &&
          actual.toLowerCase().startsWith(cond.value.toLowerCase())
        );
      case 'ends_with':
        return (
          typeof actual === 'string' &&
          typeof cond.value === 'string' &&
          actual.toLowerCase().endsWith(cond.value.toLowerCase())
        );
      case 'contains_any':
        if (!Array.isArray(actual) || !Array.isArray(cond.value)) return false;
        return cond.value.some((v) => actual.includes(v));
    }
  }

  attributes(): readonly AttributeDefinition[] {
    return ATTRIBUTES;
  }
}
