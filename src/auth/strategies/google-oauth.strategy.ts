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
// User resolution — three cases in this order:
//   1. Row with matching googleSub → return it (repeat sign-in).
//   2. Row with matching email + null googleSub → admin-invited
//      placeholder; backfill googleSub/name/photoUrl and return
//      approved.
//   3. No row → create with isApproved=false; user lands on
//      /access-restricted (self-service signup path — kept for
//      backward compatibility; no admin approval endpoint exists
//      yet, so effectively a dead-end until one is added).
//
// Deactivated users fail auth entirely.
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

    const user = await this.resolveUser(claim);
    if (!user || user.deactivatedAt !== null) {
      done(null, false);
      return;
    }
    done(null, user as unknown as Express.User);
  }

  private async resolveUser(claim: GoogleClaim): Promise<User | null> {
    // 1. Existing account — refresh mutable Google-authoritative fields.
    const bySub = await this.users.findOne({
      where: { googleSub: claim.googleSub },
    });
    if (bySub) {
      await this.users.update(
        { id: bySub.id },
        { name: claim.name, photoUrl: claim.photoUrl },
      );
      return this.users.findOne({ where: { id: bySub.id } });
    }

    // 2. Admin-invited placeholder — same email, no googleSub yet.
    //    Bind the two identities together on the existing row.
    const byEmail = await this.users.findOne({
      where: { email: claim.email },
    });
    if (byEmail && byEmail.googleSub === null) {
      await this.users.update(
        { id: byEmail.id },
        {
          googleSub: claim.googleSub,
          name: claim.name,
          photoUrl: claim.photoUrl,
        },
      );
      return this.users.findOne({ where: { id: byEmail.id } });
    }

    // 3. No pre-invite and no prior sign-in with a *different* email
    //    already sharing this googleSub — create as unapproved.
    //    (byEmail with a non-null googleSub would be a different
    //    Google account on the same email — treated as a conflict:
    //    fall through to null return, which surfaces as auth failure.)
    if (byEmail) return null;

    const created = this.users.create({
      googleSub: claim.googleSub,
      email: claim.email,
      name: claim.name,
      photoUrl: claim.photoUrl,
    });
    return this.users.save(created);
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
