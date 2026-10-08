import { TicketStatus } from '../database/enums';
import type { Action } from './action';
import type { Predicate, PredicateOperator } from './predicate';

const VALID_OPERATORS: ReadonlySet<PredicateOperator> = new Set<PredicateOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
]);

/**
 * Operators that MUST NOT carry a `value`. For is_empty / is_not_empty
 * the subject is the entire test.
 */
const UNARY_OPERATORS: ReadonlySet<PredicateOperator> = new Set<PredicateOperator>([
  'is_empty',
  'is_not_empty',
]);

const VALID_ACTION_TYPES: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'add_tag',
  'remove_tag',
  'set_status',
  'set_assignee',
  'set_team',
]);

const V1_SETTABLE_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  TicketStatus.OPEN,
  TicketStatus.RESOLVED,
]);

/**
 * Walk `cases` and `else_actions` and return every structural
 * problem. Returns an empty array when the rule is valid.
 * Non-throwing on purpose — the caller composes the error list
 * into a 400 response so the FE can surface every problem at once
 * rather than one at a time.
 */
export function validateCasesAndActions(
  cases: unknown,
  elseActions: unknown,
): string[] {
  const errors: string[] = [];

  if (!Array.isArray(cases)) {
    errors.push('cases must be an array');
  } else {
    cases.forEach((c, i) => {
      const path = `cases[${i}]`;
      if (!c || typeof c !== 'object') {
        errors.push(`${path}: must be an object`);
        return;
      }
      const obj = c as Record<string, unknown>;
      if (!Array.isArray(obj.conditions)) {
        errors.push(`${path}.conditions: must be an array`);
      } else {
        obj.conditions.forEach((p, j) =>
          validatePredicate(p, `${path}.conditions[${j}]`, errors),
        );
      }
      if (!Array.isArray(obj.actions)) {
        errors.push(`${path}.actions: must be an array`);
      } else if (obj.actions.length === 0) {
        errors.push(`${path}.actions: at least one action required`);
      } else {
        obj.actions.forEach((a, j) =>
          validateAction(a, `${path}.actions[${j}]`, errors),
        );
      }
    });
  }

  if (elseActions !== undefined && !Array.isArray(elseActions)) {
    errors.push('else_actions must be an array');
  } else if (Array.isArray(elseActions)) {
    elseActions.forEach((a, i) =>
      validateAction(a, `else_actions[${i}]`, errors),
    );
  }

  return errors;
}

function validatePredicate(p: unknown, path: string, errors: string[]): void {
  if (!p || typeof p !== 'object') {
    errors.push(`${path}: must be an object`);
    return;
  }
  const obj = p as Partial<Predicate>;
  if (typeof obj.field !== 'string' || obj.field.length === 0) {
    errors.push(`${path}.field: must be a non-empty string`);
  } else if (!obj.field.startsWith('event.') && !obj.field.startsWith('ticket.')) {
    errors.push(
      `${path}.field: must start with "event." or "ticket." (got "${obj.field}")`,
    );
  }
  if (
    typeof obj.operator !== 'string' ||
    !VALID_OPERATORS.has(obj.operator as PredicateOperator)
  ) {
    errors.push(`${path}.operator: must be one of ${[...VALID_OPERATORS].join(', ')}`);
    return;
  }
  const op = obj.operator;
  const isUnary = UNARY_OPERATORS.has(op);
  if (!isUnary && obj.value === undefined) {
    errors.push(`${path}.value: required for operator "${op}"`);
  }
  if (isUnary && obj.value !== undefined) {
    errors.push(`${path}.value: must be omitted for operator "${op}"`);
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(obj.value)) {
      errors.push(`${path}.value: must be an array for operator "${op}"`);
    }
  }
  if (op === 'between') {
    if (
      !Array.isArray(obj.value) ||
      obj.value.length !== 2 ||
      typeof obj.value[0] !== 'number' ||
      typeof obj.value[1] !== 'number'
    ) {
      errors.push(
        `${path}.value: must be [min, max] numeric tuple for operator "between"`,
      );
    }
  }
}

function validateAction(a: unknown, path: string, errors: string[]): void {
  if (!a || typeof a !== 'object') {
    errors.push(`${path}: must be an object`);
    return;
  }
  const obj = a as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !VALID_ACTION_TYPES.has(type as Action['type'])) {
    errors.push(
      `${path}.type: must be one of ${[...VALID_ACTION_TYPES].join(', ')} (got "${String(type)}")`,
    );
    return;
  }
  switch (type) {
    case 'add_tag':
    case 'remove_tag':
      if (typeof obj.tagName !== 'string' || obj.tagName.trim().length === 0) {
        errors.push(`${path}.tagName: must be a non-empty string`);
      } else if (!/^[a-z0-9-]+$/.test(obj.tagName)) {
        errors.push(
          `${path}.tagName: must be lowercase letters, digits, or dashes (got "${String(obj.tagName)}")`,
        );
      }
      break;
    case 'set_status':
      if (
        typeof obj.status !== 'string' ||
        !V1_SETTABLE_STATUSES.has(obj.status as TicketStatus)
      ) {
        errors.push(
          `${path}.status: must be one of ${[...V1_SETTABLE_STATUSES].join(', ')}`,
        );
      }
      break;
    case 'set_assignee':
      if (obj.userId !== null && typeof obj.userId !== 'string') {
        errors.push(
          `${path}.userId: must be a user id string or null (null = park on BOT)`,
        );
      }
      break;
    case 'set_team':
      if (typeof obj.teamId !== 'string' || obj.teamId.length === 0) {
        errors.push(`${path}.teamId: must be a non-empty string`);
      }
      break;
  }
}
