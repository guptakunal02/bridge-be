import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { User } from '@prisma/client';
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
// First-time sign-ins auto-create a User row with `isApproved = false`
// (a Bridge admin flips the flag before the account gets past
// /access-restricted). Deactivated users fail auth entirely.
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
    const claim = extractProfile(profile);
    if (!claim) {
      done(null, false);
      return;
    }

    const user = await this.prisma.user.upsert({
      where: { googleSub: claim.googleSub },
      create: {
        googleSub: claim.googleSub,
        email: claim.email,
        name: claim.name,
        photoUrl: claim.photoUrl,
      },
      // Only refresh mutable fields Google is authoritative for. Email
      // stays pinned to whatever we captured first — changing it here
      // could collide with the unique index.
      update: {
        name: claim.name,
        photoUrl: claim.photoUrl,
      },
    });

    if (user.deactivatedAt !== null) {
      done(null, false);
      return;
    }

    done(null, user as unknown as Express.User);
  }
}

interface GoogleClaim {
  googleSub: string;
  email: string;
  name: string;
  photoUrl: string | null;
}

// Google always includes an id (`sub`) and — with the `email` scope — a
// verified primary email. Missing either means the token was malformed;
// treat as auth failure.
function extractProfile(profile: Profile): GoogleClaim | null {
  const primary = profile.emails?.[0];
  const email = primary?.value?.toLowerCase();
  const verified = primary?.verified !== false;
  if (!profile.id || !email || !verified) return null;
  return {
    googleSub: profile.id,
    email,
    name: profile.displayName || email,
    photoUrl: profile.photos?.[0]?.value ?? null,
  };
}
