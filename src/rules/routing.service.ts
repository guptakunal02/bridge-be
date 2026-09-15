import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { RoutingRule } from './entities/routing-rule.entity';
import { ConditionTree, RuleEvaluatorService } from './rule-evaluator.service';
import type { IngestFacts } from './ticket-context';
import { buildTicketContext } from './ticket-context';

export interface RoutingResult {
  /** Team id to route the ticket to. Never null — falls back to the default team when no rule matches. */
  teamId: string;
  /** The rule that matched, if any. null when the default team was used. */
  matchedRule: { id: string; name: string } | null;
}

/**
 * The ingest-time routing hop. Given a set of ticket facts, walks
 * active rules in priority ASC order, returns the first match's
 * team_id. If nothing matches, returns null so the caller can pick
 * the default team.
 *
 * Callers running inside a transaction pass an EntityManager so the
 * read shares the connection with the surrounding writes — matters
 * for read-committed correctness when a rule is being edited at the
 * same moment ingest fires.
 */
@Injectable()
export class RoutingService {
  constructor(
    @InjectRepository(RoutingRule)
    private readonly rules: Repository<RoutingRule>,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  async routeFacts(
    facts: IngestFacts,
    mgr?: EntityManager,
  ): Promise<{
    teamId: string;
    matchedRule: { id: string; name: string };
  } | null> {
    const repo: Repository<RoutingRule> = mgr
      ? mgr.getRepository(RoutingRule)
      : this.rules;

    const active = await repo.find({
      where: { is_active: true },
      order: { priority: 'ASC', createdAt: 'ASC' },
    });
    if (active.length === 0) return null;

    const ctx = buildTicketContext(facts);
    for (const rule of active) {
      const tree = rule.condition_tree as ConditionTree;
      if (this.evaluator.evaluate(tree, ctx)) {
        return {
          teamId: rule.team_id,
          matchedRule: { id: rule.id, name: rule.name },
        };
      }
    }
    return null;
  }
}
