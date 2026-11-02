/**
 * One-off backfill — populates `variable_mapping[].path` on WhatsApp
 * templates where the admin inserted variables via the typeahead picker
 * or "Insert variable" button pre-fix. Those code paths dropped the
 * JSON path even though the picker item carried it on PickerItem.label,
 * leaving the variable as "NEEDS PATH" / "FALLBACK ONLY" on the detail
 * page.
 *
 * How to run:
 *   pnpm backfill:template-paths              # dry run
 *   pnpm backfill:template-paths --apply      # write
 *
 * Scope:
 *   - Only touches variables where path IS currently NULL (does NOT
 *     overwrite paths the admin already bound via JSON-tree click or
 *     manual Edit bindings).
 *   - Uses `authored_event` to pick the right standard-path registry.
 *     Templates with no authored_event or an event we don't have a
 *     registry for are skipped entirely.
 *   - Only applies when the variable name has a well-known mapping for
 *     that event source (name → additional.name on Clickpost, etc.).
 *     Unknown variable names stay null.
 *
 * Idempotent — second run is a no-op because paths are only set when
 * currently null.
 */
import 'dotenv/config';
import { Client } from 'pg';

const DRY_RUN = !process.argv.includes('--apply');

/**
 * Per-event-source standard paths for variable names Bridge's admins
 * most commonly bind in Surma templates. Keep in sync with the
 * flattenEventSample output + the actual payload shapes we persist.
 *
 * When adding a new event source, confirm each path exists in a real
 * sample payload BEFORE adding to the registry — a wrong path here will
 * stamp bogus bindings on existing templates.
 */
// Clickpost events — all share the same payload shape
const CLICKPOST_PATHS: Record<string, string> = {
  name: 'additional.name',
  phone: 'additional.phone',
  email: 'additional.email',
  order_id: 'additional.order_id',
  is_rvp: 'additional.is_rvp',
  waybill: 'waybill',
  awb: 'waybill',
  products: 'enrichments.order_info.products',
  courier_brand: 'enrichments.courier_brand',
  tracking_url: 'enrichments.tracking_url',
  cod_amount: 'enrichments.order_info.cod_amount',
  payment_mode: 'enrichments.order_info.payment_mode',
  order_total: 'enrichments.order_info.order_total',
  order_tags: 'enrichments.order_info.order_tags',
  financial_status: 'enrichments.order_info.financial_status',
  currency: 'enrichments.order_info.currency',
};

// Lens events wrap Clickpost payloads → subset of the same paths
const LENS_PATHS: Record<string, string> = {
  name: 'additional.name',
  phone: 'additional.phone',
  email: 'additional.email',
  order_id: 'additional.order_id',
  waybill: 'waybill',
  awb: 'waybill',
  products: 'enrichments.order_info.products',
  courier_brand: 'enrichments.courier_brand',
  tracking_url: 'enrichments.tracking_url',
};

// Shopify order events — different payload shape
const SHOPIFY_ORDER_PATHS: Record<string, string> = {
  first_name: 'customer.first_name',
  last_name: 'customer.last_name',
  name: 'customer.first_name',
  phone: 'customer.phone',
  email: 'customer.email',
  order_number: 'order_number',
  order_id: 'id',
  order_name: 'name',
  total_price: 'total_price',
  currency: 'currency',
  financial_status: 'financial_status',
  fulfillment_status: 'fulfillment_status',
};

// Return Prime created / refunded — RP's envelope shape
const RP_CREATED_PATHS: Record<string, string> = {
  name: 'customer.first_name',
  first_name: 'customer.first_name',
  phone: 'customer.phone',
  email: 'customer.email',
  order_name: 'order.name',
  order_id: 'order.id',
  request_number: 'request_number',
};

const RP_REFUNDED_PATHS: Record<string, string> = {
  ...RP_CREATED_PATHS,
  refund_amount: 'refund_amount',
};

const REGISTRY: Record<string, Record<string, string>> = {
  'clickpost.order_delivered': CLICKPOST_PATHS,
  'clickpost.return_delivered': CLICKPOST_PATHS,
  'clickpost.out_for_delivery_customer': CLICKPOST_PATHS,
  'clickpost.out_for_delivery_warehouse': CLICKPOST_PATHS,
  'clickpost.out_for_pickup_from_warehouse': CLICKPOST_PATHS,
  'clickpost.out_for_pickup_from_customer': CLICKPOST_PATHS,
  'clickpost.picked_up_from_warehouse': CLICKPOST_PATHS,
  'clickpost.picked_up_from_customer': CLICKPOST_PATHS,
  'lens.ndr': LENS_PATHS,
  'lens.npr': LENS_PATHS,
  'lens.rto': LENS_PATHS,
  'shopify.order.confirmed': SHOPIFY_ORDER_PATHS,
  'shopify.order.cancelled': SHOPIFY_ORDER_PATHS,
  'shopify.order.fulfilled': SHOPIFY_ORDER_PATHS,
  'return_prime.request.created': RP_CREATED_PATHS,
  'return_prime.request.refunded': RP_REFUNDED_PATHS,
};

interface VarEntry {
  name: string;
  path: string | null;
  example?: string | null;
  fallback?: string | null;
}

interface Row {
  id: string;
  number: string;
  name: string;
  authored_event: string | null;
  variable_mapping: VarEntry[] | null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }
  console.log(
    `${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} backfill-template-paths`,
  );

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query<Row>(`
    SELECT id, number::text, name, authored_event, variable_mapping
    FROM whatsapp_template
    WHERE variable_mapping IS NOT NULL
      AND jsonb_array_length(variable_mapping) > 0
    ORDER BY number ASC
  `);

  let touched = 0;
  let skippedNoEvent = 0;
  let skippedNoRegistry = 0;
  let totalPathsSet = 0;
  const updates: Array<{ id: string; mapping: VarEntry[] }> = [];

  for (const row of rows) {
    if (!row.authored_event) {
      skippedNoEvent++;
      continue;
    }
    const registry = REGISTRY[row.authored_event];
    if (!registry) {
      skippedNoRegistry++;
      continue;
    }
    const mapping = row.variable_mapping ?? [];
    const next: VarEntry[] = [];
    const changed: Array<{ name: string; path: string }> = [];
    for (const entry of mapping) {
      if (entry.path === null || entry.path === undefined || entry.path === '') {
        const stdPath = registry[entry.name];
        if (stdPath) {
          next.push({ ...entry, path: stdPath });
          changed.push({ name: entry.name, path: stdPath });
          continue;
        }
      }
      next.push(entry);
    }
    if (changed.length === 0) continue;
    touched++;
    totalPathsSet += changed.length;
    console.log(
      `  #${row.number} ${row.name} (${row.authored_event}): ` +
        changed.map((c) => `${c.name}→${c.path}`).join(', '),
    );
    updates.push({ id: row.id, mapping: next });
  }

  console.log(
    `\n${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} ${touched} templates would update, ` +
      `${totalPathsSet} paths total. ` +
      `${skippedNoEvent} skipped (no authored_event), ` +
      `${skippedNoRegistry} skipped (event has no registry).`,
  );

  if (DRY_RUN) {
    console.log('\nRe-run with --apply to actually write.');
    await client.end();
    return;
  }

  for (const update of updates) {
    await client.query(
      `UPDATE whatsapp_template SET variable_mapping = $1::jsonb WHERE id = $2`,
      [JSON.stringify(update.mapping), update.id],
    );
  }

  console.log(`\n[APPLY] Wrote ${updates.length} templates.`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
