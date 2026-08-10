import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedAgent } from '../types/authenticated-agent';

export const CurrentAgent = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAgent => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const agent = (request as unknown as { user?: AuthenticatedAgent }).user;
    if (!agent) {
      throw new Error('CurrentAgent used on an unauthenticated route');
    }
    return agent;
  },
);
