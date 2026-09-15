import { BotStepType, BotTrigger } from '../../../database/enums';
import { BotFlow } from '../../entities/bot-flow.entity';
import { BotStep } from '../../entities/bot-step.entity';

export interface StepResponse {
  id: string;
  flowId: string;
  position: number;
  type: BotStepType;
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface FlowResponse {
  id: string;
  name: string;
  description: string | null;
  trigger: BotTrigger;
  triggerConditions: unknown;
  isActive: boolean;
  firstStepId: string | null;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlowDetail extends FlowResponse {
  steps: StepResponse[];
}

export function toStepResponse(s: BotStep): StepResponse {
  return {
    id: s.id,
    flowId: s.flow_id,
    position: s.position,
    type: s.type,
    config: s.config,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toFlowResponse(f: BotFlow, stepCount: number): FlowResponse {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    trigger: f.trigger,
    triggerConditions: f.trigger_conditions ?? null,
    isActive: f.is_active,
    firstStepId: f.first_step_id,
    stepCount,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export function toFlowDetail(f: BotFlow, steps: BotStep[]): FlowDetail {
  return {
    ...toFlowResponse(f, steps.length),
    steps: steps.map(toStepResponse),
  };
}
