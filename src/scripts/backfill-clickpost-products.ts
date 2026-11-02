/**
 * One-off backfill — populates `payload.enrichments.order_info.products`
 * on historical clickpost_webhook_event rows by calling surma-ops's
 * `/customer-contact?waybill=<AWB>` endpoint. Mirrors the ingest-time
 * behaviour that shipped on 2026-11-02. Without this backfill, pre-
 * deploy events have an empty products slot.
 *
 * How to run (local, against prod DB):
 *   pnpm backfill:clickpost-products                 # dry run (default)
 *   pnpm backfill:clickpost-products --apply         # actually write
 *   pnpm backfill:clickpost-products --apply --limit 10  # bounded test
 *
 * Idempotent: WHERE clause skips rows that already carry a `products`
 * key under enrichments.order_info, so re-running is safe. Concurrency
 * capped at 5 parallel surma-ops calls so we don't burst their lookup
 * endpoint — enough for ~1k rows/min given the advertised 5ms p95.
 *
 * Handles:
 *   - waybill matches fulfillment → stamps the scoped products string
 *   - waybill present but no match → stamps "" (same as live ingest)
 *   - surma-ops 404 / 5xx / timeout → logs + skips (row stays missing)
 */
import 'dotenv/config';
import { Client } from 'pg';

const DRY_RUN = !process.argv.includes('--apply');
const LIMIT_IDX = process.argv.indexOf('--limit');
const LIMIT =
  LIMIT_IDX >= 0 ? Number(process.argv[LIMIT_IDX + 1]) : null;
/**
 * Opt-in — also re-process rows where products was previously stamped
 * as "" (surma-ops couldn't resolve the waybill on the earlier run).
 * Useful when surma-ops's resolution logic has improved (e.g. the
 * Clickpost reverse-waybill fallback shipped 2026-11-02), so previously
 * empty rows may now resolve. Default off so routine re-runs stay cheap
 * + don't hammer surma-ops for rows unlikely to have changed.
 */
const INCLUDE_EMPTY = process.argv.includes('--include-empty');

const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 5000;
const PROGRESS_EVERY = 250;

interface Row {
  id: string;
  order_id: string;
  waybill: string;
  cp_id: string | null;
  payload: Record<string, unknown>;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const lensUrl = process.env.LENS_CUSTOMER_CONTACT_URL;
  const secret = process.env.LENS_INTERNAL_SECRET;
  if (!dbUrl || !lensUrl || !secret) {
    console.error(
      'Missing env — need DATABASE_URL, LENS_CUSTOMER_CONTACT_URL, LENS_INTERNAL_SECRET',
    );
    process.exit(1);
  }

  console.log(
    `${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} backfill-clickpost-products ` +
      `(concurrency=${CONCURRENCY}, limit=${LIMIT ?? 'none'}, ` +
      `include-empty=${INCLUDE_EMPTY})`,
  );

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const limitClause = LIMIT ? `LIMIT ${LIMIT}` : '';
  // When --include-empty is set, also re-process rows previously stamped
  // with an empty string (surma-ops couldn't resolve earlier). Default:
  // only truly missing rows.
  const missingProductsFilter = INCLUDE_EMPTY
    ? `(
         NOT COALESCE(payload->'enrichments'->'order_info' ? 'products', false)
         OR payload->'enrichments'->'order_info'->>'products' = ''
       )`
    : `NOT COALESCE(payload->'enrichments'->'order_info' ? 'products', false)`;
  const { rows } = await client.query<Row>(`
    SELECT id::text,
           order_id,
           waybill,
           (payload->>'cp_id')::text AS cp_id,
           payload
    FROM clickpost_webhook_event
    WHERE status LIKE 'Surma %'
      AND waybill IS NOT NULL
      AND order_id IS NOT NULL
      AND ${missingProductsFilter}
    ORDER BY received_at DESC
    ${limitClause}
  `);

  console.log(`${rows.length} rows to process`);
  if (rows.length === 0) {
    await client.end();
    return;
  }

  let done = 0;
  let filled = 0;
  let emptyFromDrift = 0;
  let notFound = 0;
  let errored = 0;
  const startedAt = Date.now();

  async function processOne(row: Row): Promise<void> {
    // Pass cp_id when available — surma-ops uses it for direct Clickpost
    // /track-order calls on reverse waybills (bypassing the RP cache
    // lookup). Also future-proofs for the Rewind migration where RP
    // tables won't carry new reverse AWBs.
    const query = new URLSearchParams();
    query.set('waybill', row.waybill);
    if (row.cp_id) query.set('cp_id', row.cp_id);
    const url =
      `${lensUrl!.replace(/\/$/, '')}/${encodeURIComponent(row.order_id)}` +
      `/customer-contact?${query.toString()}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': secret! },
        signal: ac.signal,
      });
      if (res.status === 404) {
        notFound++;
        return;
      }
      if (!res.ok) {
        errored++;
        if (errored <= 5) {
          console.log(
            `  [HTTP ${res.status}] order=${row.order_id} waybill=${row.waybill}`,
          );
        }
        return;
      }
      const body = (await res.json()) as { products?: string | null };
      const products =
        typeof body.products === 'string' ? body.products : null;
      if (products === null) {
        errored++;
        return;
      }
      if (products === '') emptyFromDrift++;
      else filled++;

      if (DRY_RUN) {
        if (done < 5) {
          const preview =
            products.length > 80 ? `${products.slice(0, 80)}…` : products;
          console.log(
            `  would set order=${row.order_id} waybill=${row.waybill} products="${preview}"`,
          );
        }
        return;
      }

      // Read-modify-write — preserves any existing enrichments.* keys
      // (contact_source + the other order_info fields that are already
      // there from the live PII un-mask). jsonb_set with COALESCE
      // handles the case where enrichments or order_info don't exist
      // yet (would be rare since enrichMaskedContact runs before
      // persistence, but defensive).
      await client.query(
        `
        UPDATE clickpost_webhook_event
        SET payload = jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(payload, '{}'::jsonb),
              '{enrichments}',
              COALESCE(payload->'enrichments', '{}'::jsonb),
              true
            ),
            '{enrichments,order_info}',
            COALESCE(payload->'enrichments'->'order_info', '{}'::jsonb),
            true
          ),
          '{enrichments,order_info,products}',
          to_jsonb($1::text),
          true
        )
        WHERE id = $2
        `,
        [products, row.id],
      );
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      if (errored <= 5) {
        console.log(
          `  [ERR] order=${row.order_id} waybill=${row.waybill}: ${msg}`,
        );
      }
    } finally {
      clearTimeout(timer);
      done++;
      if (done % PROGRESS_EVERY === 0 || done === rows.length) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rate = done / elapsedSec;
        const etaSec = (rows.length - done) / rate;
        console.log(
          `  ${done}/${rows.length}  ` +
            `filled=${filled} empty=${emptyFromDrift} notFound=${notFound} err=${errored}  ` +
            `(${rate.toFixed(0)}/s, eta=${etaSec.toFixed(0)}s)`,
        );
      }
    }
  }

  // Simple N-way concurrency pool
  const queue = [...rows];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      await processOne(row);
    }
  });
  await Promise.all(workers);

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} Done in ${totalSec}s | ` +
      `total=${done} filled=${filled} empty=${emptyFromDrift} ` +
      `notFound=${notFound} err=${errored}`,
  );
  if (DRY_RUN) {
    console.log('\nRe-run with --apply to actually write.');
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
