import { Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import type { AddressObject, EmailAddress, ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';
import { AccessTokenCache } from '../../channels/email/access-token-cache';
import type { EmailChannelCredentials } from '../../channels/email/email-credentials';
import {
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SENT_MAILBOX,
} from '../../channels/email/email-credentials';
import type { IngestEmailInbox } from '../dto/req.dto';
import type { EmailInboxService } from '../email-inbox.service';

/**
 * One IMAP IDLE session for a single Bridge channel + mailbox.
 *
 * Two flavours:
 *   - mode: 'inbox' → watches INBOX, calls EmailInboxService.ingestInbound
 *     on each new message (customer replies land here)
 *   - mode: 'sent'  → watches [Gmail]/Sent Mail, calls ingestSent so
 *     replies an agent sent directly from Gmail (bypassing Bridge)
 *     still land on the ticket
 *
 * Both use XOAUTH2 SASL: the auth loop pulls a fresh Google access
 * token from AccessTokenCache on each connect/reconnect and hands
 * it to ImapFlow via auth.accessToken. When the socket dies (Gmail
 * caps IDLE at ~30min, tokens expire at ~1h), we drop back to the
 * reconnect branch and start clean with a fresh token.
 */
export type ImapMode = 'inbox' | 'sent';

const HEARTBEAT_MS = 30_000;
const POLL_MS = 60_000;

export class ImapConnection {
  private client: ImapFlow;
  private stopped = false;
  private lastUid: number | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private readonly mailbox: string;

  constructor(
    private readonly channelId: string,
    private readonly creds: EmailChannelCredentials,
    private readonly inbox: EmailInboxService,
    private readonly tokens: AccessTokenCache,
    private readonly logger: Logger,
    private readonly mode: ImapMode = 'inbox',
  ) {
    this.mailbox = mode === 'sent' ? GMAIL_SENT_MAILBOX : 'INBOX';
    this.client = this.buildClient('');
  }

  private buildClient(accessToken: string): ImapFlow {
    return new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: {
        user: this.creds.address,
        accessToken,
      },
      logger: false,
    });
  }

  private async freshToken(): Promise<string> {
    return this.tokens.get(this.channelId, this.creds.refreshToken);
  }

  async start(): Promise<void> {
    const token = await this.freshToken();
    this.client = this.buildClient(token);
    const label = `imap:${this.channelId}:${this.mode}`;
    this.logger.log(
      `[${label}] connecting to ${GMAIL_IMAP_HOST}:${GMAIL_IMAP_PORT} as ${this.creds.address} → ${this.mailbox}`,
    );
    await this.client.connect();
    const mb = await this.openMailboxOrFallback();

    // Everything already present at connect time is "old" — we ingest
    // only messages that arrive after this point. On restart the
    // idempotency check on external_message_id would catch any
    // overlap anyway, but skipping the historical scan here saves
    // an entire FETCH pass.
    this.lastUid = (mb.uidNext ?? 1) - 1;
    this.logger.log(
      `[${label}] mailbox open. messages=${mb.exists} uidNext=${mb.uidNext} lastUid=${this.lastUid}`,
    );

    this.wireEvents();
    this.startHeartbeat();
    this.startPoller();

    void this.idleLoop();
    this.logger.log(`[${label}] IDLE loop launched`);
  }

  /**
   * Open the target mailbox; if the primary name doesn't exist
   * (translated locale for the Gmail Sent folder), fall back to the
   * mailbox flagged with `\Sent` via a mailbox list. For INBOX we
   * never take the fallback path — that name is universal.
   */
  private async openMailboxOrFallback(): Promise<{
    exists: number;
    uidNext?: number;
  }> {
    try {
      return await this.client.mailboxOpen(this.mailbox);
    } catch (err) {
      if (this.mode !== 'sent') throw err;
      const boxes = await this.client.list();
      const sent = boxes.find(
        (b) =>
          b.specialUse === '\\Sent' ||
          b.flags?.has('\\Sent') ||
          b.name.toLowerCase().includes('sent'),
      );
      if (!sent) throw err;
      this.logger.warn(
        `[imap:${this.channelId}:sent] fallback: opening "${sent.path}" instead of "${this.mailbox}"`,
      );
      return await this.client.mailboxOpen(sent.path);
    }
  }

  private wireEvents(): void {
    const label = `imap:${this.channelId}:${this.mode}`;
    this.client.on('exists', (data: unknown) => {
      this.logger.log(`[${label}] EXISTS event: ${JSON.stringify(data)}`);
      if (this.stopped) return;
      void this.drainNewMessages('exists-event');
    });
    this.client.on('close', () => {
      this.logger.warn(`[${label}] connection closed`);
    });
    this.client.on('error', (err: Error) => {
      this.logger.error(`[${label}] client error: ${err.message}`);
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    const label = `imap:${this.channelId}:${this.mode}`;
    this.heartbeat = setInterval(() => {
      if (this.stopped) return;
      const mb = this.client.mailbox;
      if (mb && typeof mb === 'object') {
        this.logger.log(
          `[${label}] heartbeat: usable=${this.client.usable} authenticated=${this.client.authenticated} messages=${mb.exists} uidNext=${mb.uidNext} lastUid=${this.lastUid}`,
        );
      } else {
        this.logger.warn(
          `[${label}] heartbeat: no mailbox open (usable=${this.client.usable})`,
        );
      }
    }, HEARTBEAT_MS);
  }

  private startPoller(): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      if (this.stopped) return;
      void this.drainNewMessages('poll-tick');
    }, POLL_MS);
  }

  /**
   * Enter IDLE and stay there. When the connection drops (network
   * blip, Gmail's ~30-min cap, access-token expiry), we pause, mint
   * a fresh access token, and reconnect. Access tokens live in the
   * cache with a 60s safety margin, so the fresh one always has
   * plenty of runway.
   */
  private async idleLoop(): Promise<void> {
    const label = `imap:${this.channelId}:${this.mode}`;
    while (!this.stopped) {
      try {
        const started = Date.now();
        await this.client.idle();
        this.logger.log(
          `[${label}] IDLE returned normally after ${Date.now() - started}ms`,
        );
      } catch (err) {
        if (this.stopped) return;
        this.logger.warn(
          `[${label}] IDLE errored: ${(err as Error).message} — reconnecting in 5s`,
        );
        // Invalidate the cached token — if the error was auth-related,
        // the next `freshToken()` call will refresh from Google.
        this.tokens.invalidate(this.channelId);
        await sleep(5000);
        try {
          const token = await this.freshToken();
          this.client = this.buildClient(token);
          await this.client.connect();
          const mb = await this.openMailboxOrFallback();
          if (this.lastUid == null) this.lastUid = (mb.uidNext ?? 1) - 1;
          this.wireEvents();
          this.logger.log(
            `[${label}] reconnected. lastUid=${this.lastUid}`,
          );
        } catch (reconnectErr) {
          this.logger.error(
            `[${label}] reconnect failed: ${(reconnectErr as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Fetch every message with UID > lastUid, ingest them one by one.
   * Idempotency on external_message_id means a duplicate call is a
   * no-op (that's what lets us safely ingest agent replies from the
   * Sent folder even when we sent them ourselves via SMTP — the
   * Message-ID matches what we persisted then).
   *
   * lastUid only advances after a SUCCESSFUL ingest — a failing
   * message gets retried on the next drain.
   */
  private async drainNewMessages(trigger: string): Promise<void> {
    const label = `imap:${this.channelId}:${this.mode}`;
    if (this.lastUid == null) {
      this.logger.warn(`[${label}] drain(${trigger}) skipped: lastUid null`);
      return;
    }
    const range = `${this.lastUid + 1}:*`;
    let seen = 0;
    let ingested = 0;
    try {
      for await (const msg of this.client.fetch(
        range,
        { source: true, uid: true },
        { uid: true },
      )) {
        seen++;
        const uid = msg.uid;
        // Gmail quirk: `X:*` where X > uidNext returns the highest
        // existing UID rather than an empty result. Filter those
        // out so the drain stays a no-op when there's genuinely
        // nothing new.
        if (uid && this.lastUid != null && uid <= this.lastUid) continue;
        if (!msg.source) {
          this.logger.warn(
            `[${label}] drain(${trigger}) uid=${uid} has no source — skipping`,
          );
          if (uid) this.lastUid = Math.max(this.lastUid, uid);
          continue;
        }
        try {
          const parsed = await simpleParser(msg.source);
          const dto = toIngestDto(parsed);
          if (!dto) {
            this.logger.warn(
              `[${label}] drain(${trigger}) uid=${uid} unusable envelope — skipping`,
            );
            if (uid) this.lastUid = Math.max(this.lastUid, uid);
            continue;
          }
          if (this.mode === 'sent') {
            await this.inbox.ingestSent(this.channelId, dto);
          } else {
            await this.inbox.ingestInbound(this.channelId, dto);
          }
          ingested++;
          if (uid) this.lastUid = Math.max(this.lastUid, uid);
        } catch (parseOrIngestErr) {
          this.logger.error(
            `[${label}] drain(${trigger}) uid=${uid} ingest failed: ${(parseOrIngestErr as Error).message}`,
          );
          // Do NOT advance lastUid — retry on next tick.
        }
      }
    } catch (fetchErr) {
      this.logger.error(
        `[${label}] drain(${trigger}) fetch failed: ${(fetchErr as Error).message}`,
      );
    }
    this.logger.log(
      `[${label}] drain(${trigger}) done: seen=${seen} ingested=${ingested} lastUid=${this.lastUid}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    try {
      await this.client.logout();
    } catch {
      // ignore — socket may already be closed
    }
  }
}

function toIngestDto(parsed: ParsedMail): IngestEmailInbox | null {
  const sender = firstAddress(parsed.from);
  const receiver = allAddresses(parsed.to);
  const externalMessageId = parsed.messageId?.trim();

  if (!sender || receiver.length === 0 || !externalMessageId) return null;

  const html =
    typeof parsed.html === 'string' && parsed.html.trim().length > 0
      ? parsed.html
      : undefined;

  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.contentDisposition !== 'inline')
    .map((a) => ({
      filename: (a.filename ?? 'attachment').trim() || 'attachment',
      contentType: a.contentType ?? 'application/octet-stream',
      size: Number(a.size ?? a.content?.length ?? 0),
      body: a.content,
    }));

  const references = normaliseReferences(parsed.references);
  const inReplyTo = parsed.inReplyTo?.trim() || undefined;

  return {
    sender,
    receiver,
    subject: parsed.subject?.trim() || undefined,
    content: parsed.text?.trim() || '',
    contentHtml: html,
    external_message_id: externalMessageId,
    inReplyTo,
    references: references.length > 0 ? references : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function normaliseReferences(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.split(/\s+/);
  return items.map((s) => s.trim()).filter(Boolean);
}

function firstAddress(header: ParsedMail['from']): string | null {
  if (!header) return null;
  const arr: AddressObject[] = Array.isArray(header) ? header : [header];
  const first: EmailAddress | undefined = arr[0]?.value?.[0];
  const addr = first?.address?.trim().toLowerCase();
  return addr ?? null;
}

function allAddresses(header: ParsedMail['to']): string[] {
  if (!header) return [];
  const arr: AddressObject[] = Array.isArray(header) ? header : [header];
  return arr
    .flatMap((h) => h.value ?? [])
    .map((v) => v.address?.trim().toLowerCase())
    .filter((a): a is string => Boolean(a));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
