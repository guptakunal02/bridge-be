import { Injectable, Logger } from '@nestjs/common';
import { GoogleOAuthService } from './google-oauth.service';

interface CacheEntry {
  accessToken: string;
  /** Absolute epoch-ms at which the token stops working per Google. */
  expiresAt: number;
}

/**
 * Refresh tokens are long-lived and safe on disk; access tokens
 * are short-lived (~1h) and cheap to re-mint. We keep the fresh
 * ones in memory keyed by channel id so hot paths (IMAP reconnect,
 * SMTP send) don't call Google every time. A 60s safety margin on
 * expiry means we always hand out a token with plenty of runway
 * left — not a token that'll expire mid-request.
 *
 * On process restart the cache is empty; the first request per
 * channel refreshes lazily and repopulates. That's fine — refresh
 * is a single HTTPS round-trip.
 */
@Injectable()
export class AccessTokenCache {
  private readonly logger = new Logger(AccessTokenCache.name);
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly oauth: GoogleOAuthService) {}

  async get(channelId: string, refreshToken: string): Promise<string> {
    const now = Date.now();
    const cached = this.entries.get(channelId);
    if (cached && cached.expiresAt > now + 60_000) {
      return cached.accessToken;
    }
    // Coalesce concurrent refreshes for the same channel — otherwise
    // every IMAP reconnect on the same second would hammer Google.
    const existing = this.inflight.get(channelId);
    if (existing) return existing;

    const p = this.oauth
      .refreshAccessToken(refreshToken)
      .then(({ accessToken, expiresAt }) => {
        this.entries.set(channelId, { accessToken, expiresAt });
        return accessToken;
      })
      .finally(() => {
        this.inflight.delete(channelId);
      });
    this.inflight.set(channelId, p);
    return p;
  }

  /** Purge a channel's cached token — used when we detect it was
   *  rejected by IMAP / SMTP (e.g. token got revoked mid-session). */
  invalidate(channelId: string): void {
    this.entries.delete(channelId);
  }
}
