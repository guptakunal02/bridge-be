import type { Action } from './action';
import type { AutomationRule } from './entities/automation-rule.entity';
import { AUTOMATION_EVENT } from './events';
import type { Predicate } from './predicate';

/**
 * Build a tag-level graph across all `tag.applied` rules and
 * detect cycles. Each edge X → Y means: "if tag X is applied,
 * some case somewhere runs `add_tag(Y)` and will emit a new
 * tag.applied(Y) event" (modulo idempotency — the handler
 * short-circuits when the tag's already present, which is the
 * actual loop brake at runtime, but authors appreciate a heads-up
 * before they ship the rule).
 *
 * Returns an array of cycle descriptions. Empty when the current
 * rule set is cycle-free.
 */
export function detectTagLoops(rules: AutomationRule[]): string[] {
  const graph = new Map<string, Set<string>>();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.event !== AUTOMATION_EVENT.TAG_APPLIED) continue;
    const cases = Array.isArray(rule.cases) ? rule.cases : [];
    for (const c of cases) {
      if (!c || typeof c !== 'object') continue;
      const obj = c as Record<string, unknown>;
      const triggerTags = extractTriggerTags(
        Array.isArray(obj.conditions) ? (obj.conditions as Predicate[]) : [],
      );
      const addedTags = extractAddedTags(
        Array.isArray(obj.actions) ? (obj.actions as Action[]) : [],
      );
      if (triggerTags.length === 0 || addedTags.length === 0) continue;
      for (const from of triggerTags) {
        const edges = graph.get(from) ?? new Set<string>();
        for (const to of addedTags) edges.add(to);
        graph.set(from, edges);
      }
    }
  }

  return findCycles(graph);
}

/**
 * Extract the specific tag(s) this case's conditions trigger on.
 * Only looks at predicates of the form:
 *   event.tagName equals "X"
 *   event.tagName in ["X", "Y"]
 * Anything more exotic (contains, regex-like) isn't modelled as
 * an edge — admins get no warning for those, but at runtime the
 * loop brake (idempotent handlers) still catches real loops.
 */
function extractTriggerTags(conditions: Predicate[]): string[] {
  const out: string[] = [];
  for (const p of conditions) {
    if (p.field !== 'event.tagName') continue;
    if (p.operator === 'equals' && typeof p.value === 'string') {
      out.push(p.value);
    } else if (p.operator === 'in' && Array.isArray(p.value)) {
      for (const v of p.value) if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

function extractAddedTags(actions: Action[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    if (a.type === 'add_tag' && typeof a.tagName === 'string') {
      out.push(a.tagName);
    }
  }
  return out;
}

/**
 * Classic DFS with gray/black colouring. When we revisit a gray
 * node we've found a cycle; walk the predecessor chain to format
 * the human-readable path.
 */
function findCycles(graph: Map<string, Set<string>>): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const cycles = new Set<string>();

  function visit(node: string): void {
    color.set(node, GRAY);
    const edges = graph.get(node) ?? new Set<string>();
    for (const next of edges) {
      const c = color.get(next) ?? WHITE;
      if (c === WHITE) {
        parent.set(next, node);
        visit(next);
      } else if (c === GRAY) {
        // Walk back from `node` to `next` to reconstruct the cycle.
        const path: string[] = [next];
        let cur: string | null = node;
        while (cur && cur !== next) {
          path.unshift(cur);
          cur = parent.get(cur) ?? null;
        }
        path.unshift(next);
        const key = normaliseCycleKey(path);
        cycles.add(key);
      }
    }
    color.set(node, BLACK);
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      parent.set(node, null);
      visit(node);
    }
  }

  return [...cycles].map(
    (c) => `Possible tag loop: ${c} (idempotent handlers prevent runtime looping, but double-check these rules.)`,
  );
}

/**
 * Rotate a cycle so it starts at its lexicographically smallest
 * element. Two rules that discover the same cycle from different
 * entry points dedupe to one warning.
 */
function normaliseCycleKey(cycle: string[]): string {
  if (cycle.length <= 2) return cycle.join(' → ');
  // Drop the trailing duplicate (cycle[0] === cycle[cycle.length-1]).
  const trimmed = cycle.slice(0, -1);
  let minIdx = 0;
  for (let i = 1; i < trimmed.length; i++) {
    const a = trimmed[i];
    const b = trimmed[minIdx];
    if (a !== undefined && b !== undefined && a < b) minIdx = i;
  }
  const rotated = [...trimmed.slice(minIdx), ...trimmed.slice(0, minIdx)];
  const first = rotated[0];
  if (first !== undefined) rotated.push(first);
  return rotated.join(' → ');
}
