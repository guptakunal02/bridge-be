/**
 * One-off import of Surma's Shopify products catalogue from a CSV
 * export (Products → Export → "All products" from Shopify Admin).
 *
 * Shopify's CSV format: one row per (variant × image). A product with
 * 6 sizes and 4 images gets up to 24 rows. Product-level columns
 * (Title, Vendor, Body) are populated only on the FIRST row for that
 * handle; subsequent rows for the same handle just carry variant /
 * image fields.
 *
 * How to run (on EC2):
 *   pnpm import:shopify-products              # dry run
 *   pnpm import:shopify-products --apply      # actually write
 *
 * Idempotent: upserts ON CONFLICT (shopify_handle) + ON CONFLICT (sku)
 * so running twice overwrites stale fields instead of duplicating. The
 * importer keeps the EXISTING product + variant uuids so FKs on
 * downstream tables (none today, but future reservation / tagging
 * features would use them) stay stable.
 */
import 'dotenv/config';
import { parse } from 'csv-parse';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { AppDataSource } from '../database/data-source';
import { Product } from '../products/entities/product.entity';
import { ProductVariant } from '../products/entities/product-variant.entity';

interface CsvRow {
  Handle: string;
  Title: string;
  'Body (HTML)': string;
  Vendor: string;
  Type: string;
  Tags: string;
  Status: string;
  'Variant SKU': string;
  'Option1 Value': string;
  'Variant Price': string;
  'Variant Compare At Price': string;
  'Variant Inventory Qty': string;
  'Variant Barcodes': string;
  'Image Src': string;
  'Image Position': string;
  'Variant Image': string;
}

/** In-memory accumulator per handle while we stream the CSV. */
interface ProductDraft {
  handle: string;
  title: string;
  vendor: string | null;
  status: string | null;
  product_type: string | null;
  tags: string[];
  body_html: string | null;
  /** Image URLs keyed by position so we can sort cleanly at end. */
  imagesByPosition: Map<number, string>;
  /** Variants keyed by SKU — same SKU appears on multiple rows
   *  (one per image); first non-empty wins. */
  variants: Map<string, VariantDraft>;
}

interface VariantDraft {
  sku: string;
  option_value: string | null;
  price: string | null;
  compare_at_price: string | null;
  inventory_qty: number | null;
  variant_image_url: string | null;
  barcode: string | null;
}

const APPLY = process.argv.includes('--apply');
const CSV_PATH = resolve(__dirname, '../../products_export_1.csv');

function nullIfEmpty(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function parseTags(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseInt10(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  console.log(`[${APPLY ? 'APPLY' : 'DRY-RUN'}] reading ${CSV_PATH}`);

  const drafts = new Map<string, ProductDraft>();
  let rowsRead = 0;

  // Stream parse — the Shopify export is 17k rows but we don't want
  // to hold the full file in memory as a single string.
  const parser = createReadStream(CSV_PATH).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true }),
  );

  for await (const row of parser as AsyncIterable<CsvRow>) {
    rowsRead++;
    const handle = nullIfEmpty(row.Handle);
    if (!handle) continue;

    let draft = drafts.get(handle);
    if (!draft) {
      draft = {
        handle,
        title: nullIfEmpty(row.Title) ?? handle,
        vendor: nullIfEmpty(row.Vendor),
        status: nullIfEmpty(row.Status)?.toLowerCase() ?? null,
        product_type: nullIfEmpty(row.Type),
        tags: parseTags(row.Tags),
        body_html: nullIfEmpty(row['Body (HTML)']),
        imagesByPosition: new Map(),
        variants: new Map(),
      };
      drafts.set(handle, draft);
    } else {
      // Later rows for the same handle may have the product-level
      // fields blank (Shopify only puts them on the first row). But
      // if they ARE populated, let them refresh the draft — no harm.
      const t = nullIfEmpty(row.Title);
      if (t) draft.title = t;
      const v = nullIfEmpty(row.Vendor);
      if (v) draft.vendor = v;
      const s = nullIfEmpty(row.Status);
      if (s) draft.status = s.toLowerCase();
      const pt = nullIfEmpty(row.Type);
      if (pt) draft.product_type = pt;
      const tgs = parseTags(row.Tags);
      if (tgs.length > 0 && draft.tags.length === 0) draft.tags = tgs;
      const body = nullIfEmpty(row['Body (HTML)']);
      if (body && !draft.body_html) draft.body_html = body;
    }

    // Image row — append to the ordered map.
    const imgUrl = nullIfEmpty(row['Image Src']);
    const imgPos = parseInt10(row['Image Position']);
    if (imgUrl && imgPos !== null) {
      if (!draft.imagesByPosition.has(imgPos)) {
        draft.imagesByPosition.set(imgPos, imgUrl);
      }
    }

    // Variant row — SKU is the key. First row wins for conflicts.
    const sku = nullIfEmpty(row['Variant SKU']);
    if (sku && !draft.variants.has(sku)) {
      draft.variants.set(sku, {
        sku,
        option_value: nullIfEmpty(row['Option1 Value']),
        price: nullIfEmpty(row['Variant Price']),
        compare_at_price: nullIfEmpty(row['Variant Compare At Price']),
        inventory_qty: parseInt10(row['Variant Inventory Qty']),
        variant_image_url: nullIfEmpty(row['Variant Image']),
        barcode: nullIfEmpty(row['Variant Barcodes']),
      });
    }
  }

  console.log(
    `parsed ${rowsRead} rows → ${drafts.size} products, ${Array.from(
      drafts.values(),
    ).reduce((sum, d) => sum + d.variants.size, 0)} variants`,
  );

  if (!APPLY) {
    const sample = Array.from(drafts.values()).slice(0, 3);
    for (const d of sample) {
      const sortedImages = Array.from(d.imagesByPosition.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, u]) => u);
      console.log(
        `  ex: ${d.handle} — ${d.title} [${d.status}] variants=${d.variants.size} images=${sortedImages.length}`,
      );
    }
    console.log('DRY-RUN — pass --apply to write');
    return;
  }

  await AppDataSource.initialize();
  const productRepo = AppDataSource.getRepository(Product);
  const variantRepo = AppDataSource.getRepository(ProductVariant);

  let productsUpserted = 0;
  let variantsUpserted = 0;

  await AppDataSource.transaction(async (mgr) => {
    const pRepo = mgr.getRepository(Product);
    const vRepo = mgr.getRepository(ProductVariant);
    for (const draft of drafts.values()) {
      const sortedImages = Array.from(draft.imagesByPosition.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, u]) => u);
      const primary = sortedImages[0] ?? null;

      // ON CONFLICT (shopify_handle) upsert — keeps the uuid stable
      // across re-imports so downstream FKs don't shift.
      await pRepo.upsert(
        {
          shopify_handle: draft.handle,
          title: draft.title,
          vendor: draft.vendor,
          status: draft.status,
          product_type: draft.product_type,
          tags: draft.tags,
          primary_image_url: primary,
          image_urls: sortedImages,
          body_html: draft.body_html,
        },
        { conflictPaths: ['shopify_handle'] },
      );
      productsUpserted++;

      // Pull the (possibly fresh) uuid so we can wire the FK on variants.
      const parent = await pRepo.findOne({
        where: { shopify_handle: draft.handle },
        select: { id: true },
      });
      if (!parent) continue;

      for (const vd of draft.variants.values()) {
        await vRepo.upsert(
          {
            product_id: parent.id,
            sku: vd.sku,
            option_value: vd.option_value,
            price: vd.price,
            compare_at_price: vd.compare_at_price,
            inventory_qty: vd.inventory_qty,
            variant_image_url: vd.variant_image_url,
            barcode: vd.barcode,
          },
          { conflictPaths: ['sku'] },
        );
        variantsUpserted++;
      }
    }
  });

  console.log(
    `done: upserted ${productsUpserted} products, ${variantsUpserted} variants`,
  );
  await AppDataSource.destroy();
  // Repos aren't used after the transaction — reference them so the
  // import isn't flagged as unused by eslint if --fix runs later.
  void productRepo;
  void variantRepo;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
