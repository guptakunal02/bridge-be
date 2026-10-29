/**
 * One-off backfill — rewrites existing `email_message.content_html`
 * rows so inline base64 images point at the S3 URL on the matching
 * attachment row instead of embedding the raw base64 bytes. Mirrors
 * the ingest-time behaviour that ships alongside this script; without
 * running the backfill, historical threads keep their bloated HTML.
 *
 * Why this exists:
 *   Oct 29 2026 — a 24 MB thread (ticket 1956) killed bridge-be with
 *   a serializer OOM. Root cause: mailparser double-storing inline
 *   images (once as base64 in parsed.html, once as a separate
 *   attachment part). We stored both. Ingest now rewrites at save
 *   time; this script fixes everything older than that fix.
 *
 * How to run (on EC2):
 *   pnpm backfill:inline-images              # dry run (default)
 *   pnpm backfill:inline-images --apply      # actually write
 *
 * Idempotent: the regex only matches `data:image/*;base64,...` so
 * running twice is a no-op. Streams rows in BATCH_SIZE chunks so the
 * backfill process itself can't OOM on a huge table.
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import {
  hasInlineBase64Image,
  rewriteInlineBase64Images,
} from '../email-inbox/inline-images';

const BATCH_SIZE = 100;

interface MessageRow {
  id: string;
  content_html: string;
}

interface AttachmentRow {
  message_id: string;
  content_type: string;
  storage_url: string;
}

async function run(apply: boolean, ds: DataSource): Promise<void> {
  const scanned = { total: 0, matched: 0, rewritten: 0, bytesSaved: 0 };
  // email_message.id is a uuid column, so the keyset cursor needs a
  // valid uuid at start-of-table. The nil uuid sorts before every
  // real one and keeps the `id > $1` predicate type-correct.
  let lastId = '00000000-0000-0000-0000-000000000000';

  // Keyset pagination over email_message so we don't load the whole
  // table into memory. Only columns we need; content_html can be huge
  // so we stream in batches of 100 and release after each loop.
  for (;;) {
    const rows: MessageRow[] = await ds.query(
      `
        SELECT id, content_html
        FROM email_message
        WHERE content_html IS NOT NULL
          AND content_html LIKE '%data:image/%'
          AND id > $1
        ORDER BY id
        LIMIT $2
      `,
      [lastId, BATCH_SIZE],
    );
    if (rows.length === 0) break;
    scanned.total += rows.length;

    // Fetch attachments for the whole batch in one query so we avoid
    // N+1 round trips. Group them in a map keyed by message_id.
    const ids = rows.map((r) => r.id);
    const attachments: AttachmentRow[] = await ds.query(
      `
        SELECT message_id, content_type, storage_url
        FROM email_message_attachment
        WHERE message_id = ANY($1::uuid[])
        ORDER BY message_id, "createdAt"
      `,
      [ids],
    );
    const byMessage = new Map<string, AttachmentRow[]>();
    for (const a of attachments) {
      const bucket = byMessage.get(a.message_id);
      if (bucket) bucket.push(a);
      else byMessage.set(a.message_id, [a]);
    }

    for (const row of rows) {
      if (!hasInlineBase64Image(row.content_html)) continue;
      scanned.matched++;
      const atts = byMessage.get(row.id) ?? [];
      const rewritten = rewriteInlineBase64Images(row.content_html, atts);
      if (rewritten === row.content_html) continue;
      scanned.rewritten++;
      scanned.bytesSaved += row.content_html.length - rewritten.length;
      if (apply) {
        await ds.query(
          `UPDATE email_message SET content_html = $1 WHERE id = $2`,
          [rewritten, row.id],
        );
      }
    }

    lastId = rows[rows.length - 1]!.id;
    const mb = (scanned.bytesSaved / 1024 / 1024).toFixed(2);
    console.log(
      `[${apply ? 'APPLY' : 'DRY'}] scanned=${scanned.total} matched=${scanned.matched} rewritten=${scanned.rewritten} savedMB=${mb} lastId=${lastId.slice(0, 8)}…`,
    );
  }

  const mb = (scanned.bytesSaved / 1024 / 1024).toFixed(2);
  console.log('— done —');
  console.log(
    `${apply ? 'applied' : 'would apply'}: ${scanned.rewritten}/${scanned.matched} rewrites, ${mb} MB saved`,
  );
  if (!apply) console.log('run again with --apply to write');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await AppDataSource.initialize();
  try {
    await run(apply, AppDataSource);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
