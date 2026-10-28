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
import type { ImapResumeStore } from './imap-resume-store.service';

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
    private readonly resumeStore: ImapResumeStore,
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

    // Resume from the persisted cursor if we have one — that's
    // how we avoid silently burying mail that landed in the folder
    // while the worker was down. First-boot fallback: `uidNext - 1`,
    // which replicates the historical "skip everything already here"
    // behaviour. Idempotency on external_message_id means replaying
    // a few messages after a crash is a safe no-op.
    const persisted = await this.resumeStore.read(this.channelId, this.mode);
    if (persisted !== null) {
      this.lastUid = persisted;
    } else {
      this.lastUid = (mb.uidNext ?? 1) - 1;
    }
    this.logger.log(
      `[${label}] mailbox open. messages=${mb.exists} uidNext=${mb.uidNext} lastUid=${this.lastUid} resumed=${persisted !== null}`,
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
          // Clear listeners from the old client BEFORE dropping the ref.
          // Gmail terminates IDLE every ~30 minutes; each reconnect built
          // a fresh ImapFlow but left the old instance's `exists` / `close`
          // / `error` listeners attached. Over ~4h of reconnects the
          // retained closures (and their captured scope) grew the heap
          // past V8's default 970 MB ceiling and OOM-killed the process.
          // See: pm2 restart loop 2026-10-27, bridge-be process id=1.
          try {
            this.client.removeAllListeners();
          } catch {
            // ignore — old client may already be in a bad state
          }
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
        let parsedForLog: ParsedMail | null = null;
        try {
          const parsed = await simpleParser(msg.source);
          parsedForLog = parsed;
          const dto = toIngestDto(parsed);
          if (!dto) {
            this.logger.warn(
              `[${label}] drain(${trigger}) uid=${uid} unusable envelope — skipping (messageId=${parsed.messageId ?? 'n/a'})`,
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
          // Release off-heap buffers so V8 doesn't have to wait for the
          // iterator to free them. Confirmed root cause of the Oct 28
          // OOM cascade: msg.source + parsed.attachments[].content are
          // Node Buffers (external memory, not V8 heap). The iterator
          // and mailparser can hold these alive beyond the iteration
          // scope. Explicit null-out drops the reference so GC can
          // reclaim the external memory on the next sweep.
          (msg as { source?: Buffer | null }).source = null;
          if (parsed.attachments) {
            for (const a of parsed.attachments) {
              (a as { content?: Buffer | null }).content = null;
            }
          }
          parsedForLog = null;
        } catch (parseOrIngestErr) {
          // Fail-forward: skip the message, log with enough detail
          // for a manual re-ingest from Gmail, and keep the cursor
          // moving. Previous "don't advance lastUid" turned any
          // single ingest crash into a stalled queue — one bad
          // message blocked every subsequent email until pm2
          // restart. Prefer losing visibility on one message over
          // a silent inbox outage.
          const msgId = parsedForLog?.messageId ?? 'unparsed';
          const sender =
            parsedForLog?.from && 'text' in parsedForLog.from
              ? parsedForLog.from.text
              : 'unknown';
          const subject = parsedForLog?.subject ?? '(no subject)';
          this.logger.error(
            `[${label}] drain(${trigger}) uid=${uid} ingest failed — SKIPPING. messageId=${msgId} from=${sender} subject="${subject}" error=${(parseOrIngestErr as Error).message}`,
          );
          if (uid) this.lastUid = Math.max(this.lastUid, uid);
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
    // Persist the cursor. We write unconditionally — even on an
    // empty drain the stored value should be "we've seen through
    // UID N", because an interrupted-and-resumed worker that
    // re-reads the DB expects an authoritative value. Write
    // failures are swallowed by the store (logged there).
    if (this.lastUid !== null) {
      await this.resumeStore.write(
        this.channelId,
        this.mode,
        this.lastUid,
      );
    }
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
    // Defensive: strip listeners after logout too, in case the channel is
    // restarted later and the old client object outlives the GC window.
    try {
      this.client.removeAllListeners();
    } catch {
      // ignore
    }
  }
}

function toIngestDto(parsed: ParsedMail): IngestEmailInbox | null {
  // Reply-To wins over From when the sender set one (RFC 5322
  // §3.6.2). Judge.me, Shopify review relays, mailing lists —
  // these send with From=<relay> and Reply-To=<the real human>,
  // so an agent clicking Reply should message the human, not
  // the relay.
  //
  // We treat Reply-To as the authoritative "sender" for the
  // whole ticket's lifetime: customer detection in the sidebar,
  // list "who" column, and default-reply recipient all key off
  // email_message.sender. One hop here fixes all three.
  //
  // Historical bug (ticket #1123, 2026-10-08): judge.me notified
  // us of a 5-star review from bhavanishankar65269@gmail.com with
  // From=support@judge.me, Reply-To=bhavanishankar65269@gmail.com.
  // Bridge picked From, so a reply would've landed with judge.me
  // instead of the customer.
  const fromAddress = firstAddress(parsed.from);
  const sender = firstAddress(parsed.replyTo) ?? fromAddress;
  // Receiver list used by the "not-addressed-to-us" gate. Union of
  // THREE sources so BCC / CC / forwarded / alias deliveries all
  // register our inbox as a recipient:
  //   * parsed.to  — the direct TO recipients
  //   * parsed.cc  — the CC recipients (customers who CC our inbox
  //                  on a mail primarily aimed elsewhere)
  //   * Delivered-To — stamped by the receiving MTA (Gmail/Postfix)
  //                    on every message delivered to this mailbox
  //                    REGARDLESS of what the sender wrote in TO.
  //                    This is what catches BCC: the BCC header is
  //                    stripped before delivery, so the only trace
  //                    of "I was BCC'd on this" is Delivered-To.
  // Delivered-To is unspoofable from the sender side — the receiving
  // server stamps it after accepting the message, so trusting it
  // doesn't open any gates we wouldn't want open.
  const receiver = Array.from(
    new Set([
      ...allAddresses(parsed.to),
      ...allAddresses(parsed.cc),
      ...deliveredToAddresses(parsed.headers),
    ]),
  );
  const externalMessageId = parsed.messageId?.trim();

  if (!sender || receiver.length === 0 || !externalMessageId) return null;

  const html =
    typeof parsed.html === 'string' && parsed.html.trim().length > 0
      ? parsed.html
      : undefined;

  // Keep every attachment mailparser surfaces — including those
  // marked Content-Disposition: inline. Gmail mobile (and many
  // other clients) mark genuine photo evidence as inline when the
  // sender embedded them visually; the earlier `!== 'inline'`
  // filter was throwing away real customer attachments.
  // Historical bug (ticket #1107, 2026-10-07): two product photos
  // from a complaint arrived with contentDisposition='inline' and
  // vanished. Trade-off accepted: signature logos may now land as
  // attachments (minor UX noise); no customer evidence is ever
  // dropped (critical).
  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: (a.filename ?? 'attachment').trim() || 'attachment',
    contentType: a.contentType ?? 'application/octet-stream',
    size: Number(a.size ?? a.content?.length ?? 0),
    body: a.content,
  }));

  const references = normaliseReferences(parsed.references);
  const inReplyTo = parsed.inReplyTo?.trim() || undefined;

  return {
    sender,
    fromAddress: fromAddress ?? undefined,
    receiver,
    subject: parsed.subject?.trim() || undefined,
    content: parsed.text?.trim() || '',
    contentHtml: html,
    external_message_id: externalMessageId,
    inReplyTo,
    references: references.length > 0 ? references : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    isAutoSubmitted: detectAutoSubmitted(parsed, sender, fromAddress),
  };
}

/**
 * True when the inbound looks machine-generated. Signals, OR'd:
 *   - `Auto-Submitted` header present and not literally `no` (RFC 3834)
 *   - `Precedence: bulk|list|junk|auto_reply` (RFC 2076 convention)
 *   - `X-Auto-Response-Suppress` set (Outlook)
 *   - `Content-Type: multipart/report; report-type=delivery-status`
 *     (DSN — bounce from a receiving MTA)
 *   - Sender local-part matches `mailer-daemon`, `postmaster`,
 *     `noreply`, `no-reply`, `donotreply`, `do-not-reply`
 *
 * The gate uses the loosest-plausible interpretation on purpose:
 * false positives (we fail to auto-reply once to a legitimately
 * no-reply-named human) cost nothing; false negatives (we auto-reply
 * to a bounce) are what spawned ticket #1768's infinite loop.
 */
function detectAutoSubmitted(
  parsed: ParsedMail,
  sender: string | null,
  fromAddress: string | null,
): boolean {
  const headers = parsed.headers;
  const headerString = (key: string): string | null => {
    if (!headers || typeof headers.get !== 'function') return null;
    const raw = headers.get(key);
    if (!raw) return null;
    if (typeof raw === 'string') return raw.toLowerCase();
    if (Array.isArray(raw)) {
      return raw
        .map((v) => (typeof v === 'string' ? v : ''))
        .join(' ')
        .toLowerCase();
    }
    return null;
  };

  const autoSubmitted = headerString('auto-submitted');
  if (autoSubmitted && autoSubmitted.trim() !== 'no') return true;

  const precedence = headerString('precedence');
  if (precedence) {
    const trimmed = precedence.trim();
    if (
      trimmed === 'bulk' ||
      trimmed === 'list' ||
      trimmed === 'junk' ||
      trimmed === 'auto_reply'
    ) {
      return true;
    }
  }

  if (headerString('x-auto-response-suppress')) return true;

  const contentType = headerString('content-type');
  if (
    contentType &&
    contentType.includes('multipart/report') &&
    contentType.includes('delivery-status')
  ) {
    return true;
  }

  const addr = (sender ?? fromAddress ?? '').toLowerCase();
  const localPart = addr.split('@')[0] ?? '';
  const NO_REPLY_LOCALS = new Set([
    'mailer-daemon',
    'mailerdaemon',
    'postmaster',
    'noreply',
    'no-reply',
    'donotreply',
    'do-not-reply',
    'bounces',
    'bounce',
  ]);
  if (NO_REPLY_LOCALS.has(localPart)) return true;

  return false;
}

function normaliseReferences(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.split(/\s+/);
  return items.map((s) => s.trim()).filter(Boolean);
}

function firstAddress(
  header: ParsedMail['from'] | ParsedMail['replyTo'],
): string | null {
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

/**
 * Pull every address out of the `Delivered-To` header(s). mailparser
 * exposes raw headers via a Map (lowercased keys); the value for
 * delivered-to can be a single string, an array of strings (one per
 * header line — common on forwarded mail that was Delivered-To
 * through several hops), or a parsed address object if mailparser
 * decided to recognise it. Handle all three defensively; return
 * trimmed, lowercased, deduped addresses.
 */
function deliveredToAddresses(headers: ParsedMail['headers']): string[] {
  if (!headers || typeof headers.get !== 'function') return [];
  const raw = headers.get('delivered-to');
  if (!raw) return [];
  const strings: string[] = [];
  if (typeof raw === 'string') {
    strings.push(raw);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') strings.push(item);
    }
  } else if (typeof raw === 'object' && 'value' in raw) {
    const parsed = raw as AddressObject;
    for (const v of parsed.value ?? []) {
      if (v.address) strings.push(v.address);
    }
  }
  // Each string may be a plain address OR "Name <addr@host>" — pull
  // the bracketed address if present, else the whole thing.
  return strings
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return (m?.[1] ?? s).trim().toLowerCase();
    })
    .filter((s) => s.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
