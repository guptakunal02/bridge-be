import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types/authenticated-user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = (request as unknown as { user?: AuthenticatedUser }).user;
    if (!user) {
      throw new Error('CurrentUser used on an unauthenticated route');
    }
    return user;
  },
);
