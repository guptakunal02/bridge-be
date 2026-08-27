import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UNAPPROVED_ALLOWED_KEY } from '../decorators/unapproved-allowed.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Global guard that runs after JwtAuthGuard populates `req.user`. Blocks
 * any authenticated user who hasn't been approved by an admin from
 * reaching anything except routes explicitly marked with `@Public()` or
 * `@UnapprovedAllowed()`. Missing `req.user` is fine — the JWT guard
 * already handled the "no auth" case.
 */
@Injectable()
export class ApprovedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.hasMetadata(IS_PUBLIC_KEY, context)) return true;
    if (this.hasMetadata(UNAPPROVED_ALLOWED_KEY, context)) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) return true; // JwtAuthGuard would have already rejected

    if (!user.isApproved) {
      throw new ForbiddenException('Account is awaiting admin approval');
    }
    return true;
  }

  private hasMetadata(key: string, context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
