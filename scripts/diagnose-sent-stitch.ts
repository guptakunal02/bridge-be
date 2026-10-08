/*
 * ONE-OFF DIAGNOSTIC: for every Sent-folder message in the window
 * that failed to stitch to an existing ticket, print its subject,
 * recipient, In-Reply-To, References — plus whether each referenced
 * Message-ID exists in our DB (and if not, why).
 *
 * No DB writes. Just visibility.
 *
 * Delete after use.
 *
 * Run: pnpm ts-node scripts/diagnose-sent-stitch.ts
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { OAuth2Client } from 'google-auth-library';
import { createDecipheriv } from 'node:crypto';

const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;
const DAYS_BACK = 7;

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

const CHANNEL_KEY = Buffer.from(requireEnv('CHANNEL_ENCRYPTION_KEY'), 'base64');
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
  if (!credentials.access_token) throw new Error('no access token');
  return credentials.access_token;
}

function normaliseReferences(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : raw.split(/\s+/);
  return items.map((s) => s.trim()).filter(Boolean);
}

function allAddresses(h: ParsedMail['to']): string[] {
  if (!h) return [];
  const arr = Array.isArray(h) ? h : [h];
  return arr
    .flatMap((x) => x.value ?? [])
    .map((v) => v.address?.trim().toLowerCase())
    .filter((v): v is string => !!v);
}

async function openSent(client: ImapFlow): Promise<void> {
  try {
    await client.mailboxOpen('[Gmail]/Sent Mail');
  } catch {
    const boxes = await client.list();
    const sent = boxes.find(
      (b) =>
        b.specialUse === '\\Sent' ||
        b.flags?.has('\\Sent') ||
        b.name.toLowerCase().includes('sent'),
    );
    if (!sent) throw new Error('no sent folder');
    await client.mailboxOpen(sent.path);
  }
}

async function main(): Promise<void> {
  const { rows: channels } = await pool.query<{
    id: string;
    credentials_encrypted: string;
  }>(
    `SELECT id, credentials_encrypted FROM public.channel
     WHERE type='EMAIL' AND credentials_encrypted IS NOT NULL`,
  );

  for (const channel of channels) {
    const parsed = JSON.parse(decryptEnvelope(channel.credentials_encrypted)) as {
      address: string;
      refreshToken: string;
    };
    console.log(`\n=== channel ${channel.id.slice(0, 8)} ${parsed.address} ===`);

    const token = await freshAccessToken(parsed.refreshToken);
    const client = new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: { user: parsed.address, accessToken: token },
      logger: false,
    });
    await client.connect();
    await openSent(client);
    const lock = await client.getMailboxLock('[Gmail]/Sent Mail').catch(async () => {
      // locale fallback — mailbox is already open by openSent
      const boxes = await client.list();
      const sent = boxes.find(
        (b) =>
          b.specialUse === '\\Sent' ||
          b.flags?.has('\\Sent') ||
          b.name.toLowerCase().includes('sent'),
      );
      if (!sent) throw new Error('no sent');
      return client.getMailboxLock(sent.path);
    });

    const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
    try {
      const uids = await client.search({ since }, { uid: true });
      const list = Array.isArray(uids) ? uids : [];
      console.log(`${list.length} UIDs since ${since.toISOString()}\n`);

      for (const uid of list) {
        const fetched = await client.fetchOne(
          String(uid),
          { source: true },
          { uid: true },
        );
        if (!fetched || !fetched.source) continue;
        const mail = await simpleParser(fetched.source);
        const extId = mail.messageId?.trim();
        if (!extId) continue;

        const { rows: alreadyRows } = await pool.query<{ ticket_id: string }>(
          `SELECT ticket_id FROM public.email_message
           WHERE external_message_id = $1 LIMIT 1`,
          [extId],
        );
        if (alreadyRows.length > 0) continue; // already stored

        const refs = normaliseReferences(mail.references);
        const inReplyTo = mail.inReplyTo?.trim();
        const chain = [...refs, ...(inReplyTo ? [inReplyTo] : [])];
        const receiver = allAddresses(mail.to);

        // DB lookup for each ref — see which do + don't match
        const { rows: present } = await pool.query<{
          external_message_id: string;
          ticket_id: string;
        }>(
          `SELECT external_message_id, ticket_id FROM public.email_message
           WHERE "channelId" = $1 AND external_message_id = ANY($2::text[])`,
          [channel.id, chain],
        );
        const presentSet = new Set(present.map((p) => p.external_message_id));

        console.log(`\nuid=${uid}`);
        console.log(`  subject   : ${mail.subject ?? '(none)'}`);
        console.log(`  to        : ${receiver.join(', ') || '(none)'}`);
        console.log(`  messageId : ${extId}`);
        console.log(`  inReplyTo : ${inReplyTo ?? '(none)'}`);
        console.log(`  references:`);
        for (const r of refs) {
          console.log(`    - ${r}  ${presentSet.has(r) ? '✓ in DB' : '✗ NOT in DB'}`);
        }
        if (inReplyTo && !refs.includes(inReplyTo)) {
          console.log(`  (In-Reply-To not in References list): ${inReplyTo}  ${presentSet.has(inReplyTo) ? '✓ in DB' : '✗ NOT in DB'}`);
        }
        if (chain.length === 0) {
          console.log(`  (no References or In-Reply-To — this is a brand-new compose, not a reply)`);
        }
      }
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  }
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
