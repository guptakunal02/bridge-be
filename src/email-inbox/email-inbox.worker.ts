import { Logger } from '@nestjs/common';
import type { Channel } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EmailAdapter } from '../channels/email/email.adapter';
import type { EmailChannelCredentials } from '../channels/email/email-credentials';
import type { EmailCredentialsService } from '../channels/email/email-credentials.service';
import type { MessagesService } from '../conversations/messages.service';

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * One IMAP IDLE loop per EMAIL channel. Holds a persistent connection,
 * reacts to new-mail pushes ('exists' event), fetches the new UID range,
 * parses via mailparser, and hands off to MessagesService.ingestInbound.
 *
 * On startup we snapshot mailbox.uidNext — nothing older is imported. This
 * keeps first-time connection cheap and predictable. Anything that arrives
 * while we're disconnected is picked up on reconnect because IDLE re-syncs
 * uidNext and we range-fetch from lastSeen+1.
 *
 * ingestInbound is idempotent on Message.externalId, so a duplicate
 * fetch from a reconnect race is a no-op at the DB layer.
 */
export class EmailInboxWorker {
  private readonly logger: Logger;
  private client: ImapFlow | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private seenUidNext = 1;
  private processing: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: Channel,
    private readonly adapter: EmailAdapter,
    private readonly credentials: EmailCredentialsService,
    private readonly messages: MessagesService,
  ) {
    this.logger = new Logger(`EmailInbox[${channel.displayName}]`);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (!this.channel.credentialsEncrypted) {
      this.logger.warn('no credentials configured; skipping');
      return;
    }

    let creds: EmailChannelCredentials;
    try {
      creds = this.credentials.open(this.channel.credentialsEncrypted);
    } catch (err) {
      this.logger.error({ err }, 'failed to decrypt credentials');
      return;
    }

    this.client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: creds.imap.secure,
      auth: { user: creds.imap.username, pass: creds.imap.password },
      logger: false,
    });

    this.client.on('error', (err: Error) => {
      this.logger.warn({ err: err.message }, 'imap error');
    });
    this.client.on('close', () => {
      if (this.stopped) return;
      this.logger.warn('imap connection closed; scheduling reconnect');
      this.scheduleReconnect();
    });
    this.client.on('exists', () => {
      this.enqueueProcess();
    });

    try {
      await this.client.connect();
      const mailbox = await this.client.mailboxOpen('INBOX');
      this.seenUidNext = mailbox.uidNext;
      this.reconnectDelay = RECONNECT_DELAY_MS;
      this.logger.log(
        { uidNext: mailbox.uidNext, exists: mailbox.exists },
        'IMAP IDLE started',
      );
    } catch (err) {
      this.logger.error({ err }, 'IMAP connect failed');
      this.client = null;
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Wait for any in-flight fetch to settle before tearing down the client.
    await this.processing.catch(() => undefined);
    if (this.client) {
      await this.client.logout().catch(() => undefined);
      this.client = null;
    }
    this.logger.log('stopped');
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  private enqueueProcess(): void {
    // Serialise fetches — new 'exists' events during a fetch queue up rather
    // than fanning out concurrent fetches against the same connection.
    this.processing = this.processing
      .catch(() => undefined)
      .then(() => this.processNew());
  }

  private async processNew(): Promise<void> {
    if (!this.client || this.stopped) return;
    const mailbox = this.client.mailbox;
    if (!mailbox || typeof mailbox === 'boolean') return;

    const currentUidNext = mailbox.uidNext;
    if (currentUidNext <= this.seenUidNext) return;

    const rangeStart = this.seenUidNext;
    const rangeEnd = currentUidNext - 1;
    this.seenUidNext = currentUidNext;

    try {
      for await (const msg of this.client.fetch(
        `${rangeStart}:${rangeEnd}`,
        { source: true, uid: true },
        { uid: true },
      )) {
        if (!msg.source) continue;
        try {
          const parsed = await simpleParser(msg.source);
          // The adapter reads __channelId to attach the event to the right
          // channel without needing a stateful reference itself.
          (parsed as { __channelId?: string }).__channelId = this.channel.id;
          const events = await this.adapter.translateInbound(parsed);
          for (const event of events) {
            await this.messages.ingestInbound(event);
          }
        } catch (err) {
          this.logger.error({ err, uid: msg.uid }, 'failed to process email');
        }
      }
    } catch (err) {
      this.logger.error(
        { err, rangeStart, rangeEnd },
        'fetch failed; will retry via reconnect',
      );
      // Rewind so a reconnect picks these up.
      this.seenUidNext = rangeStart;
      if (this.client) {
        this.client.close();
      }
    }
  }
}
