/*
 * ONE-OFF: scan Gmail INBOX for messages in the last N days.
 * - Stitches each to an existing Bridge ticket via References /
 *   In-Reply-To walk; direct DB insert as RECEIVED when found.
 * - Logs (does NOT mint) any message that doesn't stitch —
 *   brand-new-ticket creation runs through team routing, picker,
 *   bot runtime etc., which this script deliberately doesn't
 *   replicate. Review the log; forward survivors to Bridge's live
 *   ingest endpoint if needed.
 *
 * Companion to backfill-sent-folder.ts. Idempotent on
 * email_message.external_message_id — safe to re-run.
 *
 * Not committed. Delete after a successful run.
 *
 * Run: pnpm ts-node scripts/backfill-inbox-folder.ts
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { OAuth2Client } from 'google-auth-library';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID, createDecipheriv } from 'node:crypto';

const AWS_REGION = 'ap-south-1';
const S3_BUCKET = 'bridge-attachments';
const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;
const DAYS_BACK = 7;

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

const CHANNEL_KEY = (() => {
  const b = Buffer.from(requireEnv('CHANNEL_ENCRYPTION_KEY'), 'base64');
  if (b.length !== 32) throw new Error('CHANNEL_ENCRYPTION_KEY must decode to 32 bytes');
  return b;
})();

const googleClientId = requireEnv('EMAIL_INBOX_GOOGLE_CLIENT_ID');
const googleClientSecret = requireEnv('EMAIL_INBOX_GOOGLE_CLIENT_SECRET');

const pool = new Pool({
  host: requireEnv('DB_HOST'),
  port: Number(process.env.DB_PORT ?? '5432'),
  database: requireEnv('DB_NAME'),
  user: requireEnv('DB_USER'),
  password: requireEnv('DB_PASSWORD'),
  ssl: { rejectUnauthorized: false },
});

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
  },
});

function decryptEnvelope(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', CHANNEL_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function freshAccessToken(refreshToken: string): Promise<string> {
  const c = new OAuth2Client(googleClientId, googleClientSecret);
  c.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await c.refreshAccessToken();
  if (!credentials.access_token) throw new Error('Google returned no access token');
  return credentials.access_token;
}

function sanitiseFilename(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^\w\-.]+/g, '') || 'attachment'
  );
}

async function uploadAttachment(
  filename: string,
  contentType: string,
  body: Buffer,
): Promise<{ key: string; url: string }> {
  const safe = sanitiseFilename(filename);
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const key = `attachments/${yyyy}/${mm}/${dd}/${randomUUID()}/${safe}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentDisposition: `attachment; filename="${safe}"`,
    }),
  );
  return {
    key,
    url: `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`,
  };
}

interface Channel {
  id: string;
  inbox_contact: string | null;
  credentials_encrypted: string;
  muted_senders: string[];
}

async function loadEmailChannels(): Promise<Channel[]> {
  const { rows } = await pool.query<Channel>(`
    SELECT id, inbox_contact, credentials_encrypted, muted_senders
    FROM public.channel
    WHERE type = 'EMAIL'
      AND credentials_encrypted IS NOT NULL
  `);
  return rows;
}

function firstAddress(h: ParsedMail['from'] | ParsedMail['replyTo']): string | null {
  if (!h) return null;
  const arr = Array.isArray(h) ? h : [h];
  const first = arr[0]?.value?.[0];
  return first?.address?.trim().toLowerCase() ?? null;
}

function allAddresses(h: ParsedMail['to']): string[] {
  if (!h) return [];
  const arr = Array.isArray(h) ? h : [h];
  return arr
    .flatMap((x) => x.value ?? [])
    .map((v) => v.address?.trim().toLowerCase())
    .filter((v): v is string => !!v);
}

function normaliseReferences(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.split(/\s+/);
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Mirror of channel-muted-senders.isMutedSender for EMAIL. */
function isMutedEmailSender(
  sender: string | null,
  patterns: string[],
): boolean {
  if (!sender || patterns.length === 0) return false;
  const normalizedSender = sender.trim().toLowerCase();
  if (normalizedSender.length === 0) return false;
  const atIndex = normalizedSender.lastIndexOf('@');
  const senderDomain =
    atIndex >= 0
      ? normalizedSender.slice(atIndex + 1).replace(/[>\s]+$/, '')
      : null;
  for (const raw of patterns) {
    const pattern = raw?.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern.includes('@')) {
      if (pattern === normalizedSender) return true;
    } else if (senderDomain !== null && senderDomain === pattern) {
      return true;
    }
  }
  return false;
}

async function findTicketByReferences(
  channelId: string,
  refs: string[],
): Promise<string | null> {
  if (refs.length === 0) return null;
  const { rows } = await pool.query<{ external_message_id: string; ticket_id: string }>(
    `SELECT external_message_id, ticket_id
     FROM public.email_message
     WHERE "channelId" = $1
       AND external_message_id = ANY($2::text[])`,
    [channelId, refs],
  );
  if (rows.length === 0) return null;
  const byMid = new Map(rows.map((r) => [r.external_message_id, r.ticket_id]));
  for (const mid of refs) {
    const t = byMid.get(mid);
    if (t) return t;
  }
  return null;
}

async function findTicketByThreadKey(
  channelId: string,
  threadKey: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM public.ticket
     WHERE channel_id = $1 AND thread_key = $2 AND "deletedAt" IS NULL
     LIMIT 1`,
    [channelId, threadKey],
  );
  return rows[0]?.id ?? null;
}

async function alreadyPersisted(externalMessageId: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM public.email_message WHERE external_message_id = $1 LIMIT 1`,
    [externalMessageId],
  );
  return rows.length > 0;
}

async function processChannel(
  channel: Channel,
): Promise<{
  scanned: number;
  recovered: number;
  alreadyThere: number;
  brandNew: Array<{ messageId: string; from: string; subject: string; receivedAt: string }>;
  muted: number;
  errors: number;
}> {
  const parsed = JSON.parse(decryptEnvelope(channel.credentials_encrypted)) as {
    address: string;
    refreshToken: string;
  };
  console.log(`\n[channel ${channel.id.slice(0, 8)}] ${parsed.address} inbox_contact=${channel.inbox_contact ?? '—'}`);

  const token = await freshAccessToken(parsed.refreshToken);
  const client = new ImapFlow({
    host: GMAIL_IMAP_HOST,
    port: GMAIL_IMAP_PORT,
    secure: true,
    auth: { user: parsed.address, accessToken: token },
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen('INBOX');
  const lock = await client.getMailboxLock('INBOX');

  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  console.log(`  scanning INBOX since ${since.toISOString()}`);

  let scanned = 0;
  let recovered = 0;
  let alreadyThere = 0;
  let muted = 0;
  let errors = 0;
  const brandNew: Array<{ messageId: string; from: string; subject: string; receivedAt: string }> = [];

  const channelInbox = channel.inbox_contact?.trim().toLowerCase() ?? null;

  try {
    const uids = await client.search({ since }, { uid: true });
    const list = Array.isArray(uids) ? uids : [];
    console.log(`  ${list.length} candidate UIDs in window`);

    for (const uid of list) {
      scanned++;
      try {
        const fetched = await client.fetchOne(
          String(uid),
          { source: true },
          { uid: true },
        );
        if (!fetched || !fetched.source) continue;
        const mail = await simpleParser(fetched.source);
        const externalMessageId = mail.messageId?.trim();
        if (!externalMessageId) continue;

        if (await alreadyPersisted(externalMessageId)) {
          alreadyThere++;
          continue;
        }

        // Replicate the live ingest's structural filters so we
        // don't resurrect messages the real ingest would reject
        // (self-send, not-addressed-to-us, muted).
        const sender = firstAddress(mail.replyTo) ?? firstAddress(mail.from);
        const receiver = allAddresses(mail.to);
        if (!sender || receiver.length === 0) continue;
        if (channelInbox && sender === channelInbox) continue;
        if (channelInbox && !receiver.includes(channelInbox)) continue;
        if (isMutedEmailSender(sender, channel.muted_senders ?? [])) {
          muted++;
          continue;
        }

        const refs = [
          ...normaliseReferences(mail.references),
          ...(mail.inReplyTo ? [mail.inReplyTo.trim()] : []),
        ];
        let ticketId = await findTicketByReferences(channel.id, refs);

        // Fallback: Bridge mints thread_key from own-Message-ID on
        // fresh threads. If this message IS the fresh one, there's
        // no stitch via References but a ticket may already exist
        // with thread_key = externalMessageId.
        if (!ticketId) {
          ticketId = await findTicketByThreadKey(channel.id, externalMessageId);
        }

        if (!ticketId) {
          // Brand-new ticket candidate — DO NOT mint from this
          // script (team routing, picker, bot runtime). Report so
          // you can decide whether to replay through the live
          // ingest endpoint.
          brandNew.push({
            messageId: externalMessageId,
            from: sender,
            subject: (mail.subject ?? '').slice(0, 80),
            receivedAt: (mail.date ?? new Date()).toISOString(),
          });
          continue;
        }

        const content = (mail.text ?? '').trim();
        const contentHtml =
          typeof mail.html === 'string' && mail.html.trim().length > 0
            ? mail.html
            : null;

        const insert = await pool.query<{ id: string }>(
          `INSERT INTO public.email_message
             ("channelId", ticket_id, type, subject, content, content_html,
              sender, receiver, external_message_id)
           VALUES ($1, $2, 'RECEIVED', $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            channel.id,
            ticketId,
            mail.subject?.trim() ?? null,
            content,
            contentHtml,
            sender,
            receiver,
            externalMessageId,
          ],
        );
        const messageId = insert.rows[0]?.id;

        for (const a of mail.attachments ?? []) {
          const filename = (a.filename ?? 'attachment').trim() || 'attachment';
          const contentType = a.contentType ?? 'application/octet-stream';
          const body = a.content as Buffer;
          const sizeBytes = Number(a.size ?? body?.length ?? 0);
          if (!body || sizeBytes === 0) continue;
          const { key, url } = await uploadAttachment(filename, contentType, body);
          await pool.query(
            `INSERT INTO public.email_message_attachment
               (message_id, filename, content_type, size_bytes, storage_key, storage_url)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [messageId, filename, contentType, sizeBytes, key, url],
          );
        }

        await pool.query(
          `INSERT INTO public.ticket_activity_log
             (ticket_id, event, actor_id, log)
           VALUES ($1, 'TICKET_MESSAGE_RECEIVED', NULL, $2)`,
          [ticketId, `Customer reply from ${sender} (backfilled)`],
        );

        recovered++;
        console.log(`  + ticket=${ticketId} uid=${uid} from=${sender} subject="${(mail.subject ?? '').slice(0, 60)}"`);
      } catch (err) {
        errors++;
        console.log(`  ! uid=${uid} ERROR: ${(err as Error).message}`);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }

  return { scanned, recovered, alreadyThere, brandNew, muted, errors };
}

async function main(): Promise<void> {
  const channels = await loadEmailChannels();
  console.log(`Loaded ${channels.length} EMAIL channel(s). Backfilling INBOX reply-on-existing for last ${DAYS_BACK} days...`);

  let scanned = 0;
  let recovered = 0;
  let alreadyThere = 0;
  let muted = 0;
  let errors = 0;
  const brandNew: Array<{ messageId: string; from: string; subject: string; receivedAt: string }> = [];

  for (const c of channels) {
    const r = await processChannel(c);
    scanned += r.scanned;
    recovered += r.recovered;
    alreadyThere += r.alreadyThere;
    muted += r.muted;
    errors += r.errors;
    brandNew.push(...r.brandNew);
  }

  console.log(
    `\n--- Done. Scanned ${scanned}. Recovered ${recovered} (reply-on-existing). Already stored ${alreadyThere}. Muted ${muted}. Errors ${errors}. ---`,
  );
  if (brandNew.length > 0) {
    console.log(
      `\n--- ${brandNew.length} brand-new-ticket candidate(s) found but NOT persisted (needs routing + picker). Review below: ---`,
    );
    for (const b of brandNew) {
      console.log(`  ${b.receivedAt}  from=${b.from}  subject="${b.subject}"  mid=${b.messageId}`);
    }
  } else {
    console.log(`\nNo brand-new-ticket candidates in the window — nothing to replay.`);
  }
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
