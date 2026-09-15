import { RoutingRule } from '../entities/routing-rule.entity';

export interface RuleResponse {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  conditionTree: unknown;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toRuleResponse(rule: RoutingRule): RuleResponse {
  return {
    id: rule.id,
    name: rule.name,
    teamId: rule.team_id,
    teamName: rule.team?.name ?? null,
    conditionTree: rule.condition_tree,
    isActive: rule.is_active,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}
