import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Agent } from '@prisma/client';
import {
  Profile,
  Strategy,
  StrategyOptions,
  VerifyCallback,
} from 'passport-google-oauth20';
import type { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';

// OAuth 2.0 authorization-code strategy for Sign in with Google. Browser is
// redirected to accounts.google.com; on approval Google 302s to
// GOOGLE_OAUTH_CALLBACK_URL with a `code` param, Passport exchanges it
// server-to-server for tokens and the verified user profile.
//
// Invite-only: unknown / deactivated emails resolve to `false`, which the
// GoogleOAuthCallbackGuard translates into a redirect to /access-restricted.
@Injectable()
export class GoogleOAuthStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly prisma: PrismaService,
  ) {
    const options: StrategyOptions = {
      clientID: config.get('GOOGLE_WEB_CLIENT_ID', { infer: true }),
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      callbackURL: config.get('GOOGLE_OAUTH_CALLBACK_URL', { infer: true }),
      scope: ['openid', 'email', 'profile'],
    };
    super(options);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const primary = profile.emails?.[0];
    const email = primary?.value?.toLowerCase();

    // `verified` is undefined on some providers; treat that as trusted since
    // Google only ever hands us its own users. Explicit `false` still blocks.
    const verified = primary?.verified !== false;
    if (!email || !verified) {
      done(null, false);
      return;
    }

    const agent = await this.prisma.agent.findUnique({ where: { email } });
    if (!agent || agent.deactivatedAt !== null) {
      done(null, false);
      return;
    }

    done(null, agent as unknown as Express.User);
  }
}
