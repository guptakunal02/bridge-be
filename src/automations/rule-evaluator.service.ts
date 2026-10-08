import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActionDispatcher } from './action-dispatcher.service';
import type { Action } from './action';
import { AutomationRule } from './entities/automation-rule.entity';
import type { AutomationEventPayload } from './events';
import { evaluateAll, type Predicate } from './predicate';

/**
 * Decoded shape of `automation_rule.cases`. Validated at the DTO
 * layer on write; the evaluator still defends against malformed
 * rows (cosmic rays, hand-edits) by skipping cases it can't parse
 * rather than throwing mid-dispatch.
 */
interface Case {
  conditions: Predicate[];
  actions: Action[];
}

/**
 * Loads every enabled rule for an event, evaluates each rule's
 * cases against the dispatched payload, and queues matching
 * actions through the ActionDispatcher.
 *
 * Semantics (locked in V1 planning):
 *   - All matching cases fire actions (no first-match-wins).
 *   - `else_actions` fire only when ZERO cases matched.
 *   - All rules run; no rule-level priority.
 *   - Within a case, conditions are ANDed.
 *   - Actions dispatch SEQUENTIALLY so idempotent-state cascades
 *     resolve deterministically (add tag → next event sees new tag).
 */
@Injectable()
export class RuleEvaluator {
  private readonly logger = new Logger(RuleEvaluator.name);

  constructor(
    @InjectRepository(AutomationRule)
    private readonly rules: Repository<AutomationRule>,
    private readonly dispatcher: ActionDispatcher,
  ) {}

  async evaluate(ctx: AutomationEventPayload): Promise<void> {
    const rules = await this.rules.find({
      where: { event: ctx.event, enabled: true },
    });
    for (const rule of rules) {
      await this.evaluateRule(rule, ctx);
    }
  }

  private async evaluateRule(
    rule: AutomationRule,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const cases = this.parseCases(rule.id, rule.cases);
    const elseActions = this.parseActions(rule.id, rule.else_actions);

    let anyMatched = false;
    for (const c of cases) {
      if (evaluateAll(c.conditions, ctx)) {
        anyMatched = true;
        for (const action of c.actions) {
          await this.dispatcher.dispatch(action, ctx);
        }
      }
    }
    if (!anyMatched) {
      for (const action of elseActions) {
        await this.dispatcher.dispatch(action, ctx);
      }
    }
  }

  private parseCases(ruleId: string, raw: unknown): Case[] {
    if (!Array.isArray(raw)) {
      this.logger.warn(
        `Rule ${ruleId}: cases is not an array; skipping all cases`,
      );
      return [];
    }
    const out: Case[] = [];
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const obj = c as Record<string, unknown>;
      const conditions = Array.isArray(obj.conditions)
        ? (obj.conditions as Predicate[])
        : [];
      const actions = Array.isArray(obj.actions)
        ? (obj.actions as Action[])
        : [];
      out.push({ conditions, actions });
    }
    return out;
  }

  private parseActions(ruleId: string, raw: unknown): Action[] {
    if (!Array.isArray(raw)) {
      this.logger.warn(
        `Rule ${ruleId}: else_actions is not an array; skipping`,
      );
      return [];
    }
    return raw as Action[];
  }
}
