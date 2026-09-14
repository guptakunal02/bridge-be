/**
 * One-shot backfill for `email_message.content_html`.
 *
 * Why this exists: the column was added in migration
 * AddEmailMessageHtml1725920000000, but every message ingested before
 * that has `content_html = NULL`. Rendering falls back to plain text
 * for those rows. This script re-fetches each such message from its
 * channel's IMAP server by Message-ID, re-parses with mailparser, and
 * writes back the HTML body when one exists.
 *
 * Safe to re-run — it only touches rows where content_html IS NULL,
 * and only sets a value when parsed.html is non-empty.
 *
 * Usage (on EC2):
 *   pnpm build
 *   node dist/scripts/backfill-email-html.js
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { DataSource, IsNull } from 'typeorm';
import { AppModule } from '../app.module';
import { EmailCredentialsService } from '../channels/email/email-credentials.service';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelType } from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';

interface MailboxSummary {
  path: string;
  specialUse?: string;
  flags?: Set<string>;
}

const log = new Logger('BackfillEmailHtml');
const RATE_LIMIT_MS = 200;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const dataSource = app.get(DataSource);
  const emailCreds = app.get(EmailCredentialsService);

  const channelRepo = dataSource.getRepository(Channel);
  const messageRepo = dataSource.getRepository(EmailMessage);

  const channels = await channelRepo.find({
    where: { type: ChannelType.EMAIL },
  });

  let totalBackfilled = 0;
  let totalSkipped = 0;

  for (const channel of channels) {
    if (!channel.credentials_encrypted) {
      log.log(`[${channel.displayName}] skipped: no credentials on file`);
      continue;
    }

    const pending = await messageRepo.find({
      where: { channelId: channel.id, content_html: IsNull() },
      order: { createdAt: 'ASC' },
    });

    if (pending.length === 0) {
      log.log(`[${channel.displayName}] nothing to backfill`);
      continue;
    }

    log.log(
      `[${channel.displayName}] ${pending.length} messages missing content_html`,
    );

    const creds = emailCreds.open(channel.credentials_encrypted);
    const client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: creds.imap.secure,
      auth: { user: creds.imap.username, pass: creds.imap.password },
      logger: false,
    });

    try {
      await client.connect();
      const mailboxPath = await pickSearchMailbox(client);
      await client.mailboxOpen(mailboxPath);
      log.log(`[${channel.displayName}] searching in ${mailboxPath}`);

      let idx = 0;
      for (const msg of pending) {
        idx++;
        const label = `${idx}/${pending.length} msg=${msg.id}`;
        try {
          const html = await fetchHtmlFor(client, msg.external_message_id);
          if (html === null) {
            log.warn(`[${channel.displayName}] ${label} NOT FOUND on server`);
            totalSkipped++;
          } else if (html.length === 0) {
            log.log(`[${channel.displayName}] ${label} no HTML body`);
            totalSkipped++;
          } else {
            await messageRepo.update({ id: msg.id }, { content_html: html });
            log.log(
              `[${channel.displayName}] ${label} backfilled (${html.length} bytes)`,
            );
            totalBackfilled++;
          }
        } catch (err) {
          log.error(
            `[${channel.displayName}] ${label} error: ${(err as Error).message}`,
          );
        }
        await sleep(RATE_LIMIT_MS);
      }
    } finally {
      try {
        await client.logout();
      } catch {
        // socket may already be gone — ignore
      }
    }
  }

  log.log(
    `done. backfilled=${totalBackfilled} skipped=${totalSkipped} (of ${totalBackfilled + totalSkipped} candidates)`,
  );

  await app.close();
}

/**
 * Prefer the mailbox flagged `\All` (Gmail's "All Mail") so archived
 * messages are still reachable. Falls back to INBOX if the server
 * doesn't advertise a `\All` folder.
 */
async function pickSearchMailbox(client: ImapFlow): Promise<string> {
  const list = (await client.list()) as MailboxSummary[];
  const all = list.find((mb) => {
    if (mb.specialUse === '\\All') return true;
    const flags = mb.flags;
    if (flags && typeof flags.has === 'function' && flags.has('\\All'))
      return true;
    return false;
  });
  return all?.path ?? 'INBOX';
}

/**
 * Locate a message by its RFC 5322 Message-ID header, fetch the raw
 * source, parse it, and return the HTML body — or:
 *   - `null` when the server can't find the message,
 *   - `''` (empty string) when found but the message is text-only.
 */
async function fetchHtmlFor(
  client: ImapFlow,
  messageId: string,
): Promise<string | null> {
  // Some servers store Message-ID with the angle brackets, some
  // without. Try both, most-specific first.
  const candidates: string[] = [messageId];
  const stripped = messageId.replace(/^<|>$/g, '');
  if (stripped !== messageId) candidates.push(stripped);
  if (!messageId.startsWith('<')) candidates.push(`<${stripped}>`);

  let uid: number | undefined;
  for (const candidate of candidates) {
    const found = await client.search(
      { header: { 'message-id': candidate } },
      { uid: true },
    );
    if (found && found.length > 0) {
      uid = found[0];
      break;
    }
  }
  if (uid === undefined) return null;

  const fetched = await client.fetchOne(
    String(uid),
    { source: true },
    { uid: true },
  );
  if (!fetched || !fetched.source) return null;

  const parsed = await simpleParser(fetched.source);
  if (typeof parsed.html === 'string' && parsed.html.trim().length > 0) {
    return parsed.html;
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((err) => {
  log.error(`backfill failed: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
