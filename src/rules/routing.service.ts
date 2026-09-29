import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Not, IsNull, Repository } from 'typeorm';
import { Team } from '../teams/entities/team.entity';
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
 * The ingest-time routing hop. Iterates teams in priority ASC order;
 * for each team, checks that team's active rules. First team where
 * any rule matches wins the ticket. If nothing matches on any team,
 * returns null so the caller falls through to the default team.
 *
 * This replaces the earlier "walk every active rule globally, first
 * match wins" model that relied on mutual-exclusion validation.
 * Priority now breaks ties, so the same conditions can appear on
 * rules attached to different teams — the higher-priority team's
 * rule wins.
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
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  async routeFacts(
    facts: IngestFacts,
    mgr?: EntityManager,
  ): Promise<{
    teamId: string;
    matchedRule: { id: string; name: string };
  } | null> {
    const ruleRepo: Repository<RoutingRule> = mgr
      ? mgr.getRepository(RoutingRule)
      : this.rules;
    const teamRepo: Repository<Team> = mgr
      ? mgr.getRepository(Team)
      : this.teams;

    // Pull every active + team-attached rule in one round trip,
    // then bucket by team_id so we don't hit the DB per-team in
    // the priority loop. Attached-only filter: rules with team_id
    // NULL are stored definitions waiting for a team to claim them.
    const active = await ruleRepo.find({
      where: { is_active: true, team_id: Not(IsNull()) },
      order: { createdAt: 'ASC' },
    });
    if (active.length === 0) return null;

    const rulesByTeam = new Map<string, RoutingRule[]>();
    for (const rule of active) {
      if (rule.team_id === null) continue;
      const bucket = rulesByTeam.get(rule.team_id);
      if (bucket) bucket.push(rule);
      else rulesByTeam.set(rule.team_id, [rule]);
    }
    if (rulesByTeam.size === 0) return null;

    // Only need teams that actually have candidate rules. Ordered
    // by priority ASC; the index idx_team_priority keeps this cheap.
    const teams = await teamRepo.find({
      where: { id: Not(IsNull()) },
      order: { priority: 'ASC', createdAt: 'ASC' },
      select: { id: true, priority: true, is_default: true },
    });

    const ctx = buildTicketContext(facts);
    for (const team of teams) {
      // The default team is the fallback — never itself a routing
      // target for rule matches. If someone attached a rule to the
      // default team, skip it here so ingest falls through cleanly.
      if (team.is_default) continue;
      const teamRules = rulesByTeam.get(team.id);
      if (!teamRules || teamRules.length === 0) continue;
      for (const rule of teamRules) {
        const tree = rule.condition_tree as ConditionTree;
        if (this.evaluator.evaluate(tree, ctx)) {
          return {
            teamId: team.id,
            matchedRule: { id: rule.id, name: rule.name },
          };
        }
      }
    }
    return null;
  }
}
