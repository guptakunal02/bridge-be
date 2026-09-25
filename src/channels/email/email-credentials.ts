import { plainToInstance } from 'class-transformer';
import { IsEmail, IsString, MinLength, validateSync } from 'class-validator';

/**
 * On-disk shape for a Gmail OAuth-based mailbox connection. Persisted
 * encrypted in Channel.credentials_encrypted; decrypted only when
 * the IMAP loop / SMTP sender / OAuth refresh needs it.
 *
 * The whole envelope is small on purpose — we own the OAuth client
 * config (client id / secret) via env vars, so per-channel state
 * is just "who are you (address)" plus "the refresh token that lets
 * us mint access tokens for that mailbox indefinitely."
 *
 * Gmail-only for now: IMAP host, port, TLS mode, and SMTP host all
 * baked in (see the GMAIL_* constants). If we ever add another
 * provider we'll introduce a discriminated union with a `provider`
 * field on this envelope.
 */
export class EmailChannelCredentials {
  /** The Gmail mailbox address, e.g. support@surma.in. */
  @IsEmail()
  address!: string;

  /**
   * Google-issued long-lived refresh token. Traded for short-lived
   * access tokens (~1h) on demand. If Google revokes it (user
   * changed password, admin removed the app, 6mo idle), all IMAP
   * + SMTP ops start failing and the channel needs to be
   * reconnected via the OAuth flow.
   */
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export function parseEmailCredentials(raw: unknown): EmailChannelCredentials {
  const instance = plainToInstance(EmailChannelCredentials, raw, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new Error(
      `Invalid email credentials: ${errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('; ')}`,
    );
  }
  return instance;
}

/**
 * Hardcoded Gmail endpoints — the whole point of going OAuth is
 * that we don't ask the user to type these ever again.
 */
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const GMAIL_IMAP_PORT = 993;
export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 465;
/**
 * Gmail's Sent Mail folder name via IMAP. `[Gmail]/Sent Mail` is
 * the standard exposed by Gmail when English-locale labels are on.
 * Other locales use translated names — we detect that in the
 * connection code by falling back to the `\Sent` special-use flag
 * on the mailbox list.
 */
export const GMAIL_SENT_MAILBOX = '[Gmail]/Sent Mail';
