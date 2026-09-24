import { Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import type { AddressObject, EmailAddress, ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';
import type { EmailChannelCredentials } from '../../channels/email/email-credentials';
import type { IngestEmailInbox } from '../dto/req.dto';
import type { EmailInboxService } from '../email-inbox.service';

/**
 * One IMAP IDLE session for a single Bridge channel.
 *
 * Opens a long-lived TLS connection to the provider's IMAP server, sits
 * in IDLE, and pushes each newly-arrived message through
 * EmailInboxService.ingestInbound. Runs a 60s polling fallback in
 * parallel so we still catch mail if IDLE is quirky.
 */
const HEARTBEAT_MS = 30_000;
const POLL_MS = 60_000;

export class ImapConnection {
  private client: ImapFlow;
  private stopped = false;
  private lastUid: number | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;

  constructor(
    private readonly channelId: string,
    private readonly creds: EmailChannelCredentials,
    private readonly inbox: EmailInboxService,
    private readonly logger: Logger,
  ) {
    this.client = this.buildClient();
  }

  private buildClient(): ImapFlow {
    return new ImapFlow({
      host: this.creds.imap.host,
      port: this.creds.imap.port,
      secure: this.creds.imap.secure,
      auth: { user: this.creds.imap.username, pass: this.creds.imap.password },
      logger: false,
    });
  }

  async start(): Promise<void> {
    this.logger.log(
      `[imap:${this.channelId}] connecting to ${this.creds.imap.host}:${this.creds.imap.port} as ${this.creds.imap.username}`,
    );
    await this.client.connect();
    const mailbox = await this.client.mailboxOpen('INBOX');

    // Everything already in the mailbox at connect time is "old" — skip it.
    this.lastUid = (mailbox.uidNext ?? 1) - 1;

    this.logger.log(
      `[imap:${this.channelId}] mailbox open. messages=${mailbox.exists} uidNext=${mailbox.uidNext} lastUid=${this.lastUid}`,
    );

    this.wireEvents();
    this.startHeartbeat();
    this.startPoller();

    void this.idleLoop();
    this.logger.log(`[imap:${this.channelId}] IDLE loop launched`);
  }

  private wireEvents(): void {
    this.client.on('exists', (data: unknown) => {
      this.logger.log(
        `[imap:${this.channelId}] EXISTS event: ${JSON.stringify(data)}`,
      );
      if (this.stopped) return;
      void this.drainNewMessages('exists-event');
    });
    this.client.on('expunge', (data: unknown) => {
      this.logger.log(
        `[imap:${this.channelId}] EXPUNGE event: ${JSON.stringify(data)}`,
      );
    });
    this.client.on('flags', (data: unknown) => {
      this.logger.log(
        `[imap:${this.channelId}] FLAGS event: ${JSON.stringify(data)}`,
      );
    });
    this.client.on('mailboxOpen', (data: unknown) => {
      const mb = data as { path?: string; exists?: number; uidNext?: number };
      this.logger.log(
        `[imap:${this.channelId}] mailboxOpen event: path=${mb.path} exists=${mb.exists} uidNext=${mb.uidNext}`,
      );
    });
    this.client.on('close', () => {
      this.logger.warn(`[imap:${this.channelId}] connection closed`);
    });
    this.client.on('error', (err: Error) => {
      this.logger.error(
        `[imap:${this.channelId}] client error: ${err.message}`,
      );
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.stopped) return;
      const mb = this.client.mailbox;
      if (mb && typeof mb === 'object') {
        this.logger.log(
          `[imap:${this.channelId}] heartbeat: usable=${this.client.usable} authenticated=${this.client.authenticated} messages=${mb.exists} uidNext=${mb.uidNext} lastUid=${this.lastUid}`,
        );
      } else {
        this.logger.warn(
          `[imap:${this.channelId}] heartbeat: no mailbox open (usable=${this.client.usable})`,
        );
      }
    }, HEARTBEAT_MS);
  }

  private startPoller(): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      if (this.stopped) return;
      this.logger.log(`[imap:${this.channelId}] polling for new messages`);
      void this.drainNewMessages('poll-tick');
    }, POLL_MS);
  }

  /**
   * Enter IDLE and stay there. If the connection drops (network blip,
   * Gmail's 30-min cap, whatever), we sleep briefly and reconnect.
   */
  private async idleLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.logger.log(`[imap:${this.channelId}] entering IDLE`);
        const started = Date.now();
        await this.client.idle();
        this.logger.log(
          `[imap:${this.channelId}] IDLE returned normally after ${Date.now() - started}ms`,
        );
      } catch (err) {
        if (this.stopped) return;
        this.logger.warn(
          `[imap:${this.channelId}] IDLE errored: ${(err as Error).message} — reconnecting in 5s`,
        );
        await sleep(5000);
        try {
          this.client = this.buildClient();
          await this.client.connect();
          const mailbox = await this.client.mailboxOpen('INBOX');
          if (this.lastUid == null) {
            this.lastUid = (mailbox.uidNext ?? 1) - 1;
          }
          this.wireEvents();
          this.logger.log(
            `[imap:${this.channelId}] reconnected. lastUid=${this.lastUid}`,
          );
        } catch (reconnectErr) {
          this.logger.error(
            `[imap:${this.channelId}] reconnect failed: ${(reconnectErr as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Fetch every message with UID > lastUid, ingest them one by one.
   * Idempotency on external_message_id means a duplicate call is a no-op.
   * lastUid only advances after a SUCCESSFUL ingest — a failing message
   * gets retried on the next drain.
   */
  private async drainNewMessages(trigger: string): Promise<void> {
    if (this.lastUid == null) {
      this.logger.warn(
        `[imap:${this.channelId}] drain(${trigger}) skipped: lastUid null`,
      );
      return;
    }
    const range = `${this.lastUid + 1}:*`;
    this.logger.log(
      `[imap:${this.channelId}] drain(${trigger}) fetching uids=${range}`,
    );
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
        // Gmail quirk: `X:*` where X > uidNext returns the highest existing
        // UID rather than an empty result. Filter those out so the drain
        // stays a no-op when there's genuinely nothing new.
        if (uid && this.lastUid != null && uid <= this.lastUid) {
          continue;
        }
        if (!msg.source) {
          this.logger.warn(
            `[imap:${this.channelId}] drain(${trigger}) uid=${uid} has no source — skipping`,
          );
          if (uid) this.lastUid = Math.max(this.lastUid, uid);
          continue;
        }
        try {
          const parsed = await simpleParser(msg.source);
          const dto = toIngestDto(parsed);
          if (!dto) {
            this.logger.warn(
              `[imap:${this.channelId}] drain(${trigger}) uid=${uid} unusable envelope (no From/To/MessageId) — skipping`,
            );
            if (uid) this.lastUid = Math.max(this.lastUid, uid);
            continue;
          }
          this.logger.log(
            `[imap:${this.channelId}] drain(${trigger}) uid=${uid} from=${dto.sender} subject="${dto.subject ?? ''}" msgid=${dto.external_message_id}`,
          );
          await this.inbox.ingestInbound(this.channelId, dto);
          ingested++;
          if (uid) this.lastUid = Math.max(this.lastUid, uid);
        } catch (parseOrIngestErr) {
          this.logger.error(
            `[imap:${this.channelId}] drain(${trigger}) uid=${uid} ingest failed: ${(parseOrIngestErr as Error).message}`,
          );
          // Do NOT advance lastUid — retry on next tick.
        }
      }
    } catch (fetchErr) {
      this.logger.error(
        `[imap:${this.channelId}] drain(${trigger}) fetch failed: ${(fetchErr as Error).message}`,
      );
    }
    this.logger.log(
      `[imap:${this.channelId}] drain(${trigger}) done: seen=${seen} ingested=${ingested} lastUid=${this.lastUid}`,
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

  // mailparser hands back attachments as a flat array of
  // {filename, contentType, size, content: Buffer}. Skip inline
  // image parts that show up embedded in the HTML body (cid: refs)
  // — those already render inside MessageBody's iframe and would
  // otherwise appear twice, once as a chip and once inline.
  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.contentDisposition !== 'inline')
    .map((a) => ({
      filename: (a.filename ?? 'attachment').trim() || 'attachment',
      contentType: a.contentType ?? 'application/octet-stream',
      size: Number(a.size ?? a.content?.length ?? 0),
      body: a.content,
    }));

  // References is a whitespace-separated Message-ID chain per RFC
  // 5322. mailparser sometimes hands us an array, sometimes a
  // single joined string — normalise both into a clean array of
  // angle-bracket-wrapped MIDs so the threading lookup can iterate.
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
