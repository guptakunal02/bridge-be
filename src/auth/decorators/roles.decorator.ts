import { SetMetadata } from '@nestjs/common';
import { AgentRole } from '@prisma/client';

export const ROLES_KEY = 'auth:roles';
export const Roles = (
  ...roles: AgentRole[]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
