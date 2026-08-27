import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import type { EnvVars } from '../../config/env.validation';

/**
 * Wraps the 'google' passport strategy so that auth failure results in a
 * browser redirect to the frontend's /access-restricted page instead of a
 * raw 401/403. Success passes through unchanged, letting the controller
 * issue a session and redirect to /inbox.
 */
@Injectable()
export class GoogleOAuthCallbackGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService<EnvVars, true>) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const activated = (await super.canActivate(context)) as boolean;
      if (activated) return true;
      // Passport didn't throw but also didn't authorize (strategy returned
      // done(null, false)) — treat identically to the throw branch.
      this.redirectAccessRestricted(context);
      return false;
    } catch {
      this.redirectAccessRestricted(context);
      return false;
    }
  }

  private redirectAccessRestricted(context: ExecutionContext): void {
    const res = context.switchToHttp().getResponse<Response>();
    const origin = this.config.get('FRONTEND_ORIGIN', { infer: true });
    res.redirect(`${origin}/access-restricted`);
  }
}
