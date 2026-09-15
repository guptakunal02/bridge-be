import { Injectable } from '@nestjs/common';
import { AttributeDefinition, findAttribute } from './attributes';
import {
  Condition,
  ConditionGroup,
  ConditionTree,
  RuleEvaluatorService,
  TicketContext,
} from './rule-evaluator.service';

export interface ValidationResult {
  /** Tree passed structural validation (types, operators, values). */
  structurallyValid: boolean;
  /** A generated context existed that satisfies the tree (rule can match). */
  matchable: boolean;
  /** The synthetic ticket the validator built to prove the rule works. */
  sampleTicket: TicketContext | null;
  /** Human-readable outcome for the FE toast. */
  message: string;
}

export interface Overlap {
  otherRuleId: string;
  otherRuleName: string;
  /** A ticket that both this candidate and the other rule would match. */
  sampleTicket: TicketContext;
}

/**
 * Owns the "Validate rule" action:
 *   1. Structurally validate the tree via the evaluator.
 *   2. Try to synthesise a TicketContext that satisfies the first
 *      group's conditions (AND'd together — every condition must
 *      pick a compatible value).
 *   3. Run the evaluator against that context. If it agrees, the
 *      rule is matchable; if it disagrees, the group's conditions
 *      contradict each other (e.g. hour = 10 AND hour = 20) and
 *      the rule can never fire.
 *
 * Nothing is persisted — no synthetic ticket ever hits the DB.
 */
@Injectable()
export class RuleValidatorService {
  constructor(private readonly evaluator: RuleEvaluatorService) {}

  validate(tree: unknown): ValidationResult {
    // Structural validation throws BadRequestException on any
    // malformed piece; catch and surface as a friendly result so the
    // FE can show it beside the button.
    try {
      this.evaluator.validate(tree);
    } catch (err) {
      return {
        structurallyValid: false,
        matchable: false,
        sampleTicket: null,
        message: (err as Error).message,
      };
    }

    const asTree = tree;
    // Try each group in order; the first that produces a matching
    // sample wins. This mirrors the runtime evaluator's OR-over-groups
    // semantics — as long as SOME group is satisfiable, the rule can
    // match a real ticket.
    for (let gi = 0; gi < asTree.groups.length; gi++) {
      const group = asTree.groups[gi];
      if (!group) continue;
      const sample = this.synthesiseFromGroup(group);
      if (!sample) continue;
      if (this.evaluator.evaluate(asTree, sample)) {
        return {
          structurallyValid: true,
          matchable: true,
          sampleTicket: sample,
          message: `Rule works. A ticket like the sample below would route through this rule.`,
        };
      }
    }

    return {
      structurallyValid: true,
      matchable: false,
      sampleTicket: null,
      message:
        'This rule can never match — the conditions contradict each other. Check for conflicting operators on the same attribute (e.g. hour equals 10 AND hour equals 20).',
    };
  }

  /**
   * Given a candidate tree and every other rule in the system, return
   * the ones the candidate would overlap with. Two rules overlap when
   * there exists a context that satisfies at least one group of each.
   *
   *   candidate matches when: any group Ai holds
   *   other     matches when: any group Bj holds
   *   overlap = ∃ i,j such that (Ai ∧ Bj) is satisfiable
   *
   * Ai ∧ Bj is itself an AND-group — we reuse synthesiseFromGroup to
   * try to build a satisfying context. If we find one, the pair
   * overlaps and we return it as the sample.
   */
  checkOverlap(
    candidate: unknown,
    others: Array<{ id: string; name: string; conditionTree: unknown }>,
  ): Overlap[] {
    // Structural failures are the caller's problem; overlap is only
    // meaningful for well-formed trees. Bail early if the candidate
    // itself is malformed — the caller already surfaces that error.
    try {
      this.evaluator.validate(candidate);
    } catch {
      return [];
    }
    const candTree = candidate;

    const overlaps: Overlap[] = [];
    for (const other of others) {
      let otherTree: ConditionTree;
      try {
        this.evaluator.validate(other.conditionTree);
        otherTree = other.conditionTree;
      } catch {
        // Skip malformed existing rules — they can't route anything
        // anyway, so they can't conflict.
        continue;
      }

      const sample = this.findOverlapSample(candTree, otherTree);
      if (sample) {
        overlaps.push({
          otherRuleId: other.id,
          otherRuleName: other.name,
          sampleTicket: sample,
        });
      }
    }
    return overlaps;
  }

  private findOverlapSample(
    a: ConditionTree,
    b: ConditionTree,
  ): TicketContext | null {
    for (const ga of a.groups) {
      for (const gb of b.groups) {
        const merged: ConditionGroup = {
          conditions: [...ga.conditions, ...gb.conditions],
        };
        const sample = this.synthesiseFromGroup(merged);
        if (!sample) continue;
        // Belt-and-braces: confirm both trees actually accept the
        // sample. synthesiseFromGroup already guarantees this for
        // the merged conditions, but running the real evaluator
        // guards against future divergence.
        if (
          this.evaluator.evaluate(a, sample) &&
          this.evaluator.evaluate(b, sample)
        ) {
          return sample;
        }
      }
    }
    return null;
  }

  /**
   * Try to build a context where every condition in the group holds.
   * Multiple conditions on the same attribute reduce/refine the
   * acceptable range; if the intersection is empty we return null and
   * the caller reports "can never match".
   */
  private synthesiseFromGroup(group: ConditionGroup): TicketContext | null {
    // Bucket conditions by attribute so we can reason about their
    // intersection.
    const byAttr = new Map<string, Condition[]>();
    for (const cond of group.conditions) {
      const bucket = byAttr.get(cond.attribute) ?? [];
      bucket.push(cond);
      byAttr.set(cond.attribute, bucket);
    }

    const ctx: TicketContext = {};
    for (const [attrKey, conds] of byAttr.entries()) {
      const attr = findAttribute(attrKey);
      if (!attr) return null; // shouldn't happen — validate() catches this
      const result = this.pickValue(attr, conds);
      if (!result.ok) return null;
      ctx[attrKey] = result.value;
    }
    return ctx;
  }

  private pickValue(attr: AttributeDefinition, conds: Condition[]): PickResult {
    if (attr.type === 'integer') {
      const value = this.pickInteger(attr, conds);
      return value === UNSATISFIABLE ? UNSAT : { ok: true, value };
    }
    if (attr.type === 'enum') {
      const value = this.pickEnum(conds);
      return value === UNSATISFIABLE ? UNSAT : { ok: true, value };
    }
    if (attr.type === 'string') {
      const value = this.pickString(conds);
      return value === UNSATISFIABLE ? UNSAT : { ok: true, value };
    }
    if (attr.type === 'string_array') {
      const value = this.pickStringArray(conds);
      return value === UNSATISFIABLE ? UNSAT : { ok: true, value };
    }
    return UNSAT;
  }

  private pickInteger(
    attr: AttributeDefinition,
    conds: Condition[],
  ): number | typeof UNSATISFIABLE {
    let lo = attr.min ?? Number.MIN_SAFE_INTEGER;
    let hi = attr.max ?? Number.MAX_SAFE_INTEGER;
    const banned = new Set<number>();
    let anchor: number | null = null;

    for (const c of conds) {
      const v = c.value;
      if (typeof v !== 'number') return UNSATISFIABLE;
      switch (c.operator) {
        case 'eq':
          if (anchor !== null && anchor !== v) return UNSATISFIABLE;
          anchor = v;
          break;
        case 'neq':
          banned.add(v);
          break;
        case 'gt':
          lo = Math.max(lo, v + 1);
          break;
        case 'gte':
          lo = Math.max(lo, v);
          break;
        case 'lt':
          hi = Math.min(hi, v - 1);
          break;
        case 'lte':
          hi = Math.min(hi, v);
          break;
      }
    }

    if (anchor !== null) {
      if (anchor < lo || anchor > hi || banned.has(anchor))
        return UNSATISFIABLE;
      return anchor;
    }
    if (lo > hi) return UNSATISFIABLE;
    // Walk the range for the first non-banned integer.
    for (let candidate = lo; candidate <= hi; candidate++) {
      if (!banned.has(candidate)) return candidate;
    }
    return UNSATISFIABLE;
  }

  private pickEnum(conds: Condition[]): string | typeof UNSATISFIABLE {
    let anchor: string | null = null;
    const banned = new Set<string>();
    for (const c of conds) {
      if (typeof c.value !== 'string') return UNSATISFIABLE;
      if (c.operator === 'eq') {
        if (anchor !== null && anchor !== c.value) return UNSATISFIABLE;
        anchor = c.value;
      } else if (c.operator === 'neq') {
        banned.add(c.value);
      }
    }
    if (anchor !== null) {
      return banned.has(anchor) ? UNSATISFIABLE : anchor;
    }
    return UNSATISFIABLE;
  }

  private pickString(conds: Condition[]): string | typeof UNSATISFIABLE {
    let candidate = 'sample';
    for (const c of conds) {
      if (typeof c.value !== 'string') return UNSATISFIABLE;
      switch (c.operator) {
        case 'eq':
          candidate = c.value;
          break;
        case 'contains':
          if (!candidate.toLowerCase().includes(c.value.toLowerCase())) {
            candidate = `${candidate}-${c.value}`;
          }
          break;
        case 'starts_with':
          if (!candidate.toLowerCase().startsWith(c.value.toLowerCase())) {
            candidate = `${c.value}${candidate}`;
          }
          break;
        case 'ends_with':
          if (!candidate.toLowerCase().endsWith(c.value.toLowerCase())) {
            candidate = `${candidate}${c.value}`;
          }
          break;
        // neq / not_contains: leave the current candidate alone —
        // it's unlikely to collide with an arbitrary neq value.
      }
    }
    // Sanity check every condition again on the final candidate;
    // if any fails we admit defeat.
    for (const c of conds) {
      if (!this.checkString(candidate, c)) return UNSATISFIABLE;
    }
    return candidate;
  }

  private checkString(candidate: string, c: Condition): boolean {
    if (typeof c.value !== 'string') return false;
    const lower = candidate.toLowerCase();
    const v = c.value.toLowerCase();
    switch (c.operator) {
      case 'eq':
        return candidate === c.value;
      case 'neq':
        return candidate !== c.value;
      case 'contains':
        return lower.includes(v);
      case 'not_contains':
        return !lower.includes(v);
      case 'starts_with':
        return lower.startsWith(v);
      case 'ends_with':
        return lower.endsWith(v);
    }
    return false;
  }

  private pickStringArray(conds: Condition[]): string[] | typeof UNSATISFIABLE {
    const required = new Set<string>();
    const anyOf: string[][] = [];
    const banned = new Set<string>();

    for (const c of conds) {
      if (c.operator === 'contains' && typeof c.value === 'string') {
        required.add(c.value);
      } else if (c.operator === 'not_contains' && typeof c.value === 'string') {
        banned.add(c.value);
      } else if (c.operator === 'contains_any' && Array.isArray(c.value)) {
        anyOf.push(c.value as string[]);
      }
    }

    for (const req of required) {
      if (banned.has(req)) return UNSATISFIABLE;
    }
    const out = Array.from(required);
    // For each contains_any group, add the first value that isn't
    // banned.
    for (const options of anyOf) {
      const pick = options.find((o) => !banned.has(o));
      if (!pick) return UNSATISFIABLE;
      if (!out.includes(pick)) out.push(pick);
    }
    return out;
  }
}

const UNSATISFIABLE = Symbol('unsatisfiable');
type PickResult = { ok: true; value: unknown } | { ok: false };
const UNSAT: PickResult = { ok: false };
