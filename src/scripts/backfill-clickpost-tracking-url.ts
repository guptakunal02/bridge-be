/**
 * One-off backfill — stamps `payload.enrichments.tracking_url` on
 * historical clickpost_webhook_event rows by constructing the branded
 * Clickpost tracking URL from the waybill. Mirrors the ingest-time
 * behaviour that shipped on 2026-11-02.
 *
 * How to run (local, against prod DB):
 *   pnpm backfill:clickpost-tracking-url               # dry run
 *   pnpm backfill:clickpost-tracking-url --apply       # write
 *
 * Pure SQL — no external calls — so this runs in seconds on 37k rows.
 * Idempotent: skips rows that already carry a tracking_url key.
 *
 * Keep the URL template in sync with the default in
 * clickpost-webhooks.service.ts's stampTrackingUrl + the env override
 * (CLICKPOST_TRACKER_URL_PREFIX).
 */
import 'dotenv/config';
import { Client } from 'pg';

const DRY_RUN = !process.argv.includes('--apply');

const PREFIX =
  process.env.CLICKPOST_TRACKER_URL_PREFIX ??
  'https://surma.clickpost.ai/en?waybill=';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  console.log(
    `${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} backfill-clickpost-tracking-url ` +
      `(prefix="${PREFIX}")`,
  );

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const audit = await client.query<{ count: string; sample_waybill: string }>(
    `
    SELECT COUNT(*)::text AS count,
           MIN(waybill) AS sample_waybill
    FROM clickpost_webhook_event
    WHERE waybill IS NOT NULL
      AND NOT COALESCE(payload->'enrichments' ? 'tracking_url', false)
    `,
  );
  const total = Number(audit.rows[0]?.count ?? '0');
  console.log(
    `\n${total} rows missing tracking_url. ` +
      `Sample URL that would land: ${PREFIX}${audit.rows[0]?.sample_waybill ?? '<waybill>'}`,
  );

  if (DRY_RUN) {
    console.log('\nRe-run with --apply to actually write.');
    await client.end();
    return;
  }

  const started = Date.now();
  const res = await client.query(
    `
    UPDATE clickpost_webhook_event
    SET payload = jsonb_set(
      jsonb_set(
        COALESCE(payload, '{}'::jsonb),
        '{enrichments}',
        COALESCE(payload->'enrichments', '{}'::jsonb),
        true
      ),
      '{enrichments,tracking_url}',
      to_jsonb($1::text || waybill),
      true
    )
    WHERE waybill IS NOT NULL
      AND NOT COALESCE(payload->'enrichments' ? 'tracking_url', false)
    `,
    [PREFIX],
  );
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[APPLY] Updated ${res.rowCount ?? 0} rows in ${sec}s.`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
