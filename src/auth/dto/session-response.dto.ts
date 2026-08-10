import { AgentRole } from '@prisma/client';

export interface SessionAgentResponse {
  id: string;
  email: string;
  name: string;
  role: AgentRole;
  avatarUrl: string | null;
}

export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  agent: SessionAgentResponse;
}
