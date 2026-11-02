/**
 * One-off backfill — stamps `payload.enrichments.courier_brand` on
 * historical clickpost_webhook_event rows by matching the raw
 * `account_code` against the carrier brand registry. Mirrors the
 * ingest-time behaviour that shipped on 2026-11-02.
 *
 * How to run (local, against prod DB):
 *   pnpm backfill:clickpost-courier-brand                 # dry run
 *   pnpm backfill:clickpost-courier-brand --apply         # write
 *
 * Pure SQL — no external calls — so this runs in seconds on 37k rows.
 * Idempotent: WHERE clause skips rows that already carry a
 * courier_brand key.
 *
 * Match registry mirrors COURIER_BRAND_REGISTRY in
 * clickpost-webhooks.service.ts. Keep them in sync when adding couriers.
 */
import 'dotenv/config';
import { Client } from 'pg';

const DRY_RUN = !process.argv.includes('--apply');

const BRANDS: Array<{ needle: string; brand: string }> = [
  { needle: 'shadowfax', brand: 'Shadowfax' },
  { needle: 'bluedart', brand: 'Bluedart' },
  { needle: 'delhivery', brand: 'Delhivery' },
  { needle: 'shiprocket', brand: 'Shiprocket' },
];

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  console.log(
    `${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} backfill-clickpost-courier-brand`,
  );

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // Dry-run audit — what would get stamped vs. what has no brand hit.
  const audit = await client.query<{ brand: string; count: string }>(
    `
    WITH classification AS (
      SELECT
        CASE
          ${BRANDS.map(
            (b, i) =>
              `WHEN LOWER(payload->>'account_code') LIKE '%${b.needle}%' THEN '${b.brand}'`,
          ).join('\n          ')}
          ELSE 'UNMATCHED'
        END AS brand
      FROM clickpost_webhook_event
      WHERE NOT COALESCE(payload->'enrichments' ? 'courier_brand', false)
        AND payload->>'account_code' IS NOT NULL
    )
    SELECT brand, COUNT(*)::text AS count
    FROM classification
    GROUP BY brand
    ORDER BY COUNT(*) DESC
    `,
  );
  console.log('\nAudit (rows missing courier_brand):');
  console.table(audit.rows);

  if (DRY_RUN) {
    console.log('\nRe-run with --apply to actually write.');
    await client.end();
    return;
  }

  // Apply — one UPDATE per brand. jsonb_set with COALESCE creates
  // enrichments object if missing (shouldn't happen on real rows but
  // defensive against any edge case where enrichMaskedContact never
  // ran).
  let totalUpdated = 0;
  for (const { needle, brand } of BRANDS) {
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
        '{enrichments,courier_brand}',
        to_jsonb($1::text),
        true
      )
      WHERE LOWER(payload->>'account_code') LIKE '%' || $2 || '%'
        AND NOT COALESCE(payload->'enrichments' ? 'courier_brand', false)
      `,
      [brand, needle],
    );
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${brand}: updated ${res.rowCount ?? 0} rows (${sec}s)`);
    totalUpdated += res.rowCount ?? 0;
  }

  console.log(`\n[APPLY] Done. Total: ${totalUpdated} rows updated.`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
