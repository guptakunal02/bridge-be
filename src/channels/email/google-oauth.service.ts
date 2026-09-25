import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { EnvVars } from '../../config/env.validation';

/**
 * Scope we ask Google for. `mail.google.com/` is the umbrella scope
 * that covers both IMAP + SMTP via XOAUTH2 — split scopes exist
 * but neither the IMAP nor the SMTP variant alone lets us do the
 * other side of the conversation, so the broad scope is the only
 * usable choice for a full-duplex email adapter.
 */
const GMAIL_SCOPE = 'https://mail.google.com/';

/**
 * Additional scopes we request alongside Gmail — userinfo is what
 * lets us read the mailbox address off the id_token/userinfo
 * endpoint on callback, so admins don't have to type it again.
 */
const OPENID_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface ExchangedTokens {
  refreshToken: string;
  accessToken: string;
  /** Absolute epoch-ms at which the access token stops working. */
  expiresAt: number;
  /** Mailbox address extracted from the id_token / userinfo. */
  address: string;
}

/**
 * Thin wrapper around google-auth-library's OAuth2Client. Owns the
 * per-request state (client id / secret / redirect URI) and gives
 * the rest of the codebase a small typed surface:
 *
 *   - buildAuthorizeUrl(state) → URL to redirect the user to
 *   - exchangeCode(code) → refresh token + first access token + address
 *   - refreshAccessToken(refreshToken) → fresh access token
 *
 * Kept separate from the sign-in Google client (which lives in
 * auth.service.ts) so a leaked sign-in token can never touch
 * mailbox data.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: string;

  constructor(config: ConfigService<EnvVars, true>) {
    this.clientId = config.get('EMAIL_INBOX_GOOGLE_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('EMAIL_INBOX_GOOGLE_CLIENT_SECRET', {
      infer: true,
    });
    this.callbackUrl = config.get('EMAIL_INBOX_GOOGLE_CALLBACK_URL', {
      infer: true,
    });
  }

  buildAuthorizeUrl(state: string, loginHint?: string): string {
    const client = this.newClient();
    // access_type=offline + prompt=consent forces Google to return
    // a refresh_token even if the user has previously granted the
    // same scopes. Without prompt=consent, subsequent authorize
    // calls only return an access_token — which would silently
    // break IMAP reconnects an hour later.
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [GMAIL_SCOPE, ...OPENID_SCOPES],
      state,
      login_hint: loginHint,
      include_granted_scopes: true,
    });
  }

  async exchangeCode(code: string): Promise<ExchangedTokens> {
    const client = this.newClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Google only omits refresh_token on repeat consent without
      // prompt=consent, which we always send. If this fires,
      // something in the config drifted.
      throw new Error(
        'Google did not return a refresh_token — cannot persist channel.',
      );
    }
    if (!tokens.access_token) {
      throw new Error('Google did not return an access_token.');
    }

    // Pull the mailbox address off the id_token (which comes back
    // because we requested openid + userinfo.email). Fall back to a
    // raw userinfo fetch only if the id_token was missing — avoids
    // pulling in the full `googleapis` package for one call, which
    // blows up type-check memory on small EC2 boxes.
    let address: string | null = null;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.clientId,
      });
      address = ticket.getPayload()?.email ?? null;
    }
    if (!address) {
      const res = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { email?: string };
        address = data.email ?? null;
      } else {
        this.logger.warn(
          `Userinfo fetch failed with ${res.status}; will fail below.`,
        );
      }
    }
    if (!address) {
      throw new Error(
        'Could not determine mailbox address from Google response.',
      );
    }

    const expiresAt =
      typeof tokens.expiry_date === 'number'
        ? tokens.expiry_date
        : Date.now() + 55 * 60 * 1000; // ~55min fallback
    return {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt,
      address: address.toLowerCase(),
    };
  }

  /**
   * Mint a fresh access token for an existing channel. Throws when
   * the refresh token has been revoked so callers can mark the
   * channel as needing reauth.
   */
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: number }> {
    const client = this.newClient();
    client.setCredentials({ refresh_token: refreshToken });
    try {
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) {
        throw new Error('Google returned no access_token on refresh.');
      }
      return {
        accessToken: credentials.access_token,
        expiresAt:
          typeof credentials.expiry_date === 'number'
            ? credentials.expiry_date
            : Date.now() + 55 * 60 * 1000,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to refresh access token: ${msg}`);
      throw err;
    }
  }

  private newClient(): OAuth2Client {
    return new OAuth2Client(this.clientId, this.clientSecret, this.callbackUrl);
  }
}
