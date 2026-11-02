/**
 * One-off backfill — stamps `enrichments.order_name` (clean "#253451",
 * no ".N" suffix) and `enrichments.products` (comma-joined item names)
 * on historical shopify_webhook_event rows. Mirrors the ingest-time
 * behaviour that shipped on 2026-11-02.
 *
 * How to run (local):
 *   pnpm backfill:shopify-enrichments               # dry run
 *   pnpm backfill:shopify-enrichments --apply       # write
 *
 * Pure derivation — no external calls — reads payload line_items
 * directly, mutates JSON in-memory, writes back. Idempotent: WHERE
 * guard skips rows that already carry both keys.
 *
 * Scope:
 *   - fulfillments/create + fulfillments/update: stamp both order_name
 *     (strip .N suffix from `name`) and products (from line_items)
 *   - orders/create + orders/fulfilled + orders/cancelled: stamp
 *     products only (order payload's `name` is already clean)
 */
import 'dotenv/config';
import { Client } from 'pg';

const DRY_RUN = !process.argv.includes('--apply');
const BATCH_SIZE = 500;

const FULFILLMENT_TOPICS = ['fulfillments/create', 'fulfillments/update'];
const ORDER_TOPICS = [
  'orders/create',
  'orders/fulfilled',
  'orders/cancelled',
];

interface Row {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

function stripOrderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const noSuffix = trimmed.replace(/\.\d+$/, '');
  const bare = noSuffix.replace(/^#/, '').trim();
  return bare.length > 0 ? `#${bare}` : null;
}

function extractProducts(payload: Record<string, unknown>): string | null {
  const items = payload['line_items'];
  if (!Array.isArray(items) || items.length === 0) return null;
  const names: string[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const name = (raw as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.trim().length > 0) {
      names.push(name.trim());
    }
  }
  return names.length > 0 ? names.join(', ') : null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  console.log(
    `${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} backfill-shopify-enrichments`,
  );

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const allTopics = [...FULFILLMENT_TOPICS, ...ORDER_TOPICS];
  const audit = await client.query<{ topic: string; count: string }>(
    `
    SELECT topic, COUNT(*)::text AS count
    FROM shopify_webhook_event
    WHERE topic = ANY($1)
    GROUP BY topic
    ORDER BY topic
    `,
    [allTopics],
  );
  console.log('\nRow counts per topic:');
  console.table(audit.rows);

  let totalTouched = 0;
  let totalScanned = 0;
  const started = Date.now();

  for (const topic of allTopics) {
    const isFulfillment = FULFILLMENT_TOPICS.includes(topic);
    const needsOrderNameClause = isFulfillment
      ? `OR NOT COALESCE(payload->'enrichments' ? 'order_name', false)`
      : '';
    // Scope only to rows that actually need stamping — massively cuts
    // the scan size vs. loading everything. received_at is indexed +
    // provides a stable sort for cursor pagination within a topic.
    let cursor = new Date('2099-01-01').toISOString();
    for (;;) {
      const { rows } = await client.query<Row & { received_at: Date }>(
        `
        SELECT id::text, topic, payload, received_at
        FROM shopify_webhook_event
        WHERE topic = $1
          AND received_at < $2
          AND (
            NOT COALESCE(payload->'enrichments' ? 'products', false)
            ${needsOrderNameClause}
          )
        ORDER BY received_at DESC
        LIMIT $3
        `,
        [topic, cursor, BATCH_SIZE],
      );
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.received_at.toISOString();
      totalScanned += rows.length;

      for (const row of rows) {
        const payload = row.payload;
        const enrichments =
          (payload['enrichments'] as Record<string, unknown> | undefined) ??
          {};
        let changed = false;

        if (isFulfillment && typeof enrichments['order_name'] !== 'string') {
          const clean = stripOrderName(payload['name']);
          if (clean) {
            enrichments['order_name'] = clean;
            changed = true;
          }
        }
        if (typeof enrichments['products'] !== 'string') {
          const products = extractProducts(payload);
          if (products) {
            enrichments['products'] = products;
            changed = true;
          }
        }

        if (!changed) continue;
        payload['enrichments'] = enrichments;
        totalTouched++;

        if (DRY_RUN) {
          if (totalTouched <= 5) {
            console.log(
              `  would stamp [${topic}] id=${row.id} ` +
                `order_name=${JSON.stringify(enrichments['order_name'] ?? '-')} ` +
                `products=${JSON.stringify(String(enrichments['products'] ?? '').slice(0, 60))}`,
            );
          }
          continue;
        }

        await client.query(
          `UPDATE shopify_webhook_event SET payload = $1::jsonb WHERE id = $2`,
          [JSON.stringify(payload), row.id],
        );
      }

      const sec = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        `  [${topic}] scanned=${totalScanned} touched=${totalTouched} (${sec}s)`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
  }

  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} Done. ` +
      `${totalTouched} rows ${DRY_RUN ? 'would update' : 'updated'} ` +
      `across ${totalScanned} scanned in ${sec}s.`,
  );
  if (DRY_RUN) console.log('Re-run with --apply to write.');

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
