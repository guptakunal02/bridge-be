import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { TagRequirementService } from '../tag-requirement.service';

/**
 * Route-level enforcement of "Require a tag before closing a ticket."
 *
 * Guards in NestJS run BEFORE ValidationPipe, so we see `request.body`
 * as raw JSON (no DTO class instance). The checker service coerces
 * the fields we need defensively — anything malformed is silently
 * ignored here and the DTO validation downstream will surface the
 * proper 400.
 *
 * Applied at controller level with @UseGuards() so an admin reading
 * the routes can see the policy without tracing into the service
 * layer. Bulk update reuses the underlying checker directly (a guard
 * would have to reject all-or-nothing, which is bad UX for a mixed
 * batch).
 */
@Injectable()
export class RequireTagsToResolveGuard implements CanActivate {
  constructor(private readonly checker: TagRequirementService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const id = (req.params as Record<string, string>).id;
    const body = req.body as Record<string, unknown> | undefined;
    if (!id) return true;
    await this.checker.assertSatisfied(id, body);
    return true;
  }
}
