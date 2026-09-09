import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '../../database/enums';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Per-route guard: require `role === ADMIN`. Runs after JwtAuthGuard +
 * ApprovedGuard so a missing/unapproved user is already handled.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
