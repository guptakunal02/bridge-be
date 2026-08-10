import { Agent, AgentRole, AgentStatus } from '@prisma/client';

export interface AgentResponse {
  id: string;
  email: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  avatarUrl: string | null;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAgentResponse(agent: Agent): AgentResponse {
  return {
    id: agent.id,
    email: agent.email,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    avatarUrl: agent.avatarUrl,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    deactivatedAt: agent.deactivatedAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}
