import type { AgentRole } from '@prisma/client';

export interface AuthenticatedAgent {
  id: string;
  email: string;
  role: AgentRole;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: AgentRole;
}
