import { SetMetadata } from '@nestjs/common';

export const UNAPPROVED_ALLOWED_KEY = 'auth:unapprovedAllowed';

/**
 * Marks a route that authenticated-but-unapproved users are still allowed
 * to hit (e.g. `/auth/me` and `/auth/logout`, which the frontend needs to
 * call while a user is stuck on `/access-restricted`).
 *
 * Read by ApprovedGuard.
 */
export const UnapprovedAllowed = (): MethodDecorator & ClassDecorator =>
  SetMetadata(UNAPPROVED_ALLOWED_KEY, true);
