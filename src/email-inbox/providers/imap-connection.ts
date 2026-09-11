import { Logger } from '@nestjs/common';
import { ImapFlow, MailboxObject } from 'imapflow';
import { ParsedMail, simpleParser } from 'mailparser';
import type { EmailChannelCredentials } from '../../channels/email/email-credentials';
import type { IngestEmailInbox } from '../dto/req.dto';
import type { EmailInboxService } from '../email-inbox.service';

/**
 * One IMAP IDLE session for a single Bridge channel.
 *
 * Opens a long-lived TLS connection to the provider's IMAP server, sits
 * in IDLE, and pushes each newly-arrived message through
 * EmailInboxService.ingestInbound. Automatically reconnects on drops
 * with a bounded back-off.
 */
export class ImapConnection {
  private client: ImapFlow;
  private stopped = false;
  private lastUid: number | null = null;

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
    await this.client.connect();
    const mailbox = (await this.client.mailboxOpen('INBOX')) as MailboxObject;

    // Everything already in the mailbox at connect time is "old" — skip it.
    // Only fetch messages with UIDs >= UIDNEXT (i.e. new arrivals).
    this.lastUid = (mailbox.uidNext ?? 1) - 1;

    this.client.on('exists', () => {
      if (this.stopped) return;
      void this.drainNewMessages();
    });

    void this.idleLoop();
    this.logger.log(
      `IMAP IDLE started for channel ${this.channelId} (${this.creds.address})`,
    );
  }

  /**
   * Enter IDLE and stay there. If the connection drops (network blip,
   * Gmail's 30-min cap, whatever), we sleep briefly and reconnect.
   */
  private async idleLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        // imapflow handles renewal internally; this resolves when IDLE
        // ends (either explicitly or via connection close).
        await this.client.idle();
      } catch (err) {
        if (this.stopped) return;
        this.logger.warn(
          `IDLE dropped on channel ${this.channelId}: ${(err as Error).message} — reconnecting in 5s`,
        );
        await sleep(5000);
        try {
          this.client = this.buildClient();
          await this.client.connect();
          const mailbox = (await this.client.mailboxOpen('INBOX')) as MailboxObject;
          // Continue from where we left off — don't reprocess.
          if (this.lastUid == null) {
            this.lastUid = (mailbox.uidNext ?? 1) - 1;
          }
          this.client.on('exists', () => {
            if (this.stopped) return;
            void this.drainNewMessages();
          });
        } catch (reconnectErr) {
          this.logger.error(
            `Reconnect failed for channel ${this.channelId}: ${(reconnectErr as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Fetch every message with UID > lastUid, ingest them one by one.
   * Idempotency on external_message_id means a duplicate call is a no-op.
   */
  private async drainNewMessages(): Promise<void> {
    if (this.lastUid == null) return;
    const range = `${this.lastUid + 1}:*`;
    try {
      for await (const msg of this.client.fetch(
        range,
        { source: true, uid: true },
        { uid: true },
      )) {
        if (msg.uid) this.lastUid = Math.max(this.lastUid, msg.uid);
        if (!msg.source) continue;
        try {
          const parsed = await simpleParser(msg.source);
          const dto = toIngestDto(parsed);
          if (!dto) continue; // missing sender / message-id — skip
          await this.inbox.ingestInbound(this.channelId, dto);
        } catch (parseOrIngestErr) {
          this.logger.error(
            `Ingest failed on channel ${this.channelId}: ${(parseOrIngestErr as Error).message}`,
          );
        }
      }
    } catch (fetchErr) {
      this.logger.error(
        `Fetch failed on channel ${this.channelId}: ${(fetchErr as Error).message}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.client.logout();
    } catch {
      // ignore — socket may already be closed
    }
  }
}

/**
 * Extract the DTO shape from a parsed message. Returns null when the
 * message doesn't have the fields Bridge requires (idempotency needs a
 * Message-ID, ticket needs a From).
 */
function toIngestDto(parsed: ParsedMail): IngestEmailInbox | null {
  const sender = firstAddress(parsed.from);
  const receiver = allAddresses(parsed.to);
  const externalMessageId = parsed.messageId?.trim();

  if (!sender || receiver.length === 0 || !externalMessageId) return null;

  return {
    sender,
    receiver,
    subject: parsed.subject?.trim() || undefined,
    content: parsed.text?.trim() || '',
    external_message_id: externalMessageId,
  };
}

function firstAddress(header: ParsedMail['from']): string | null {
  if (!header) return null;
  const arr = Array.isArray(header) ? header : [header];
  return arr[0]?.value?.[0]?.address?.trim().toLowerCase() ?? null;
}

function allAddresses(header: ParsedMail['to']): string[] {
  if (!header) return [];
  const arr = Array.isArray(header) ? header : [header];
  return arr
    .flatMap((h) => h.value ?? [])
    .map((v) => v.address?.trim().toLowerCase())
    .filter((a): a is string => Boolean(a));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
