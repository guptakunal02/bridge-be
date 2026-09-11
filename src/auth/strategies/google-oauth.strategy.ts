import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Profile,
  Strategy,
  StrategyOptions,
  VerifyCallback,
} from 'passport-google-oauth20';
import { Repository } from 'typeorm';
import type { EnvVars } from '../../config/env.validation';
import { User } from '../../users/entities/user.entity';

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
    @InjectRepository(User) private readonly users: Repository<User>,
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

    // Upsert by googleSub — only refresh mutable fields Google is
    // authoritative for. Email stays pinned to whatever we captured
    // first (initial insert only) to avoid colliding with the unique
    // index on subsequent logins. `upsert` in TypeORM only re-sets the
    // columns listed in the payload on conflict, so passing only
    // name/photoUrl in the update path is not possible with a single
    // call — we pass the full payload; email/googleSub don't change
    // between calls for the same account, so the merge is a no-op.
    await this.users.upsert(
      {
        googleSub: claim.googleSub,
        email: claim.email,
        name: claim.name,
        photoUrl: claim.photoUrl,
      },
      ['googleSub'],
    );

    const user = await this.users.findOne({
      where: { googleSub: claim.googleSub },
    });

    if (!user || user.deactivatedAt !== null) {
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
