import type { AutomationRule } from '../entities/automation-rule.entity';
import type { AutomationEventName } from '../events';

export interface AutomationRuleResponse {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  event: AutomationEventName;
  cases: unknown[];
  else_actions: unknown[];
  createdAt: string;
  updatedAt: string;
  /**
   * Non-blocking warnings surfaced on create/update. Current source:
   * tag-level loop detection across all `tag.applied` rules. Empty
   * on list/get responses (not re-computed per read).
   */
  warnings?: string[];
}

export function toAutomationRuleResponse(
  rule: AutomationRule,
): AutomationRuleResponse {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    event: rule.event as AutomationEventName,
    cases: Array.isArray(rule.cases) ? rule.cases : [],
    else_actions: Array.isArray(rule.else_actions) ? rule.else_actions : [],
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}
