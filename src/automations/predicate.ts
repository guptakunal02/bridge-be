import type { AutomationEventPayload } from './events';

/**
 * V1 predicate operators. Deliberately small — one-shot additions
 * are cheap, but every operator shipped is forever (admins start
 * depending on it). Keep until there's a real use-case.
 *
 *   equals / not_equals        — strict ===
 *   contains / not_contains    — string: case-insensitive substring; array: .includes
 *   starts_with / ends_with    — string, case-insensitive
 *   in / not_in                — value side is array; is actual value in it
 *   gt / gte / lt / lte        — numeric
 *   between                    — value side is [min, max]; inclusive
 *   is_empty / is_not_empty    — null | undefined | '' | []
 */
export type PredicateOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'is_empty'
  | 'is_not_empty';

export interface Predicate {
  /**
   * Dotted field path into the event payload. Supported roots:
   *   event.*  → event-specific payload (body, sender, tagName, hourIst, …)
   *   ticket.* → the TicketSnapshot (status, tags, assigneeId, teamId, …)
   */
  field: string;
  operator: PredicateOperator;
  /** Comparator value. Shape depends on operator (array for in/not_in/between). */
  value?: unknown;
}

/**
 * Resolve `event.body` / `ticket.tags` / etc. against the dispatched
 * payload. Returns undefined when the path doesn't exist — callers
 * (operators) treat undefined as "no match" for most comparators.
 */
export function resolveField(
  path: string,
  ctx: AutomationEventPayload,
): unknown {
  const [root, ...rest] = path.split('.');
  if (root !== 'event' && root !== 'ticket') return undefined;
  const base: unknown = root === 'event' ? ctx.payload : ctx.ticket;
  let cursor: unknown = base;
  for (const key of rest) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Evaluate a single predicate against the dispatched event. All
 * errors inside an operator (e.g. gt on a non-number) resolve to
 * `false` rather than throwing — a single malformed predicate must
 * never crash the whole engine mid-dispatch.
 */
export function evaluatePredicate(
  p: Predicate,
  ctx: AutomationEventPayload,
): boolean {
  const actual = resolveField(p.field, ctx);
  const expected = p.value;

  try {
    switch (p.operator) {
      case 'equals':
        return actual === expected;
      case 'not_equals':
        return actual !== expected;

      case 'contains':
        if (typeof actual === 'string' && typeof expected === 'string') {
          return actual.toLowerCase().includes(expected.toLowerCase());
        }
        if (Array.isArray(actual)) return actual.includes(expected);
        return false;

      case 'not_contains':
        if (typeof actual === 'string' && typeof expected === 'string') {
          return !actual.toLowerCase().includes(expected.toLowerCase());
        }
        if (Array.isArray(actual)) return !actual.includes(expected);
        return false;

      case 'starts_with':
        if (typeof actual === 'string' && typeof expected === 'string') {
          return actual.toLowerCase().startsWith(expected.toLowerCase());
        }
        return false;

      case 'ends_with':
        if (typeof actual === 'string' && typeof expected === 'string') {
          return actual.toLowerCase().endsWith(expected.toLowerCase());
        }
        return false;

      case 'in':
        if (!Array.isArray(expected)) return false;
        return expected.includes(actual);

      case 'not_in':
        if (!Array.isArray(expected)) return false;
        return !expected.includes(actual);

      case 'gt':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      case 'gte':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      case 'lt':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
      case 'lte':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;

      case 'between': {
        if (!Array.isArray(expected) || expected.length !== 2) return false;
        const [min, max] = expected;
        if (
          typeof actual !== 'number' ||
          typeof min !== 'number' ||
          typeof max !== 'number'
        ) {
          return false;
        }
        return actual >= min && actual <= max;
      }

      case 'is_empty':
        if (actual == null) return true;
        if (typeof actual === 'string') return actual.trim().length === 0;
        if (Array.isArray(actual)) return actual.length === 0;
        return false;

      case 'is_not_empty':
        if (actual == null) return false;
        if (typeof actual === 'string') return actual.trim().length > 0;
        if (Array.isArray(actual)) return actual.length > 0;
        return true;

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** AND semantics across a case's conditions. Empty array → true. */
export function evaluateAll(
  predicates: Predicate[],
  ctx: AutomationEventPayload,
): boolean {
  return predicates.every((p) => evaluatePredicate(p, ctx));
}
