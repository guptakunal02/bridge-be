import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Product catalog populated from a one-time Shopify products export
 * CSV. Two tables: `product` holds product-level fields keyed by
 * `shopify_handle`; `product_variant` holds each size/color variant
 * keyed by `sku`.
 *
 * Why both tables (vs flat): Shopify sells one PRODUCT (e.g. "Playlist
 * Kurta Set in Unplugged Green") in multiple VARIANTS (XS, S, M, …).
 * Each variant has its own SKU, price, and image. Orders reference
 * variants by SKU — so our join from `line_items.sku` → variant →
 * product gives us the right title + image for the Orders sidebar
 * card. Variants cascade-delete with their product so the one-time
 * importer can re-run cleanly after Surma edits a product.
 */
export class ProductCatalog1726480000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        shopify_handle text NOT NULL UNIQUE,
        title text NOT NULL,
        vendor text NULL,
        status text NULL,
        product_type text NULL,
        tags text[] NOT NULL DEFAULT '{}',
        primary_image_url text NULL,
        image_urls text[] NOT NULL DEFAULT '{}',
        body_html text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      -- Trigram index on title for ILIKE search in the Products tab.
      -- The btree would help prefix queries; trigram handles substrings,
      -- which is what the admin's quick search does.
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX idx_product_title_trgm
        ON product USING gin (title gin_trgm_ops);
      CREATE INDEX idx_product_status ON product (status) WHERE status IS NOT NULL;

      CREATE TABLE product_variant (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        product_id uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
        sku text NOT NULL UNIQUE,
        option_value text NULL,
        price numeric(10, 2) NULL,
        compare_at_price numeric(10, 2) NULL,
        inventory_qty integer NULL,
        variant_image_url text NULL,
        barcode text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_product_variant_product_id ON product_variant (product_id);
      -- Trigram on sku so the admin can type partial codes (e.g. "FDPC")
      -- and find all matching variants + their parent product.
      CREATE INDEX idx_product_variant_sku_trgm
        ON product_variant USING gin (sku gin_trgm_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS product_variant;
      DROP TABLE IF EXISTS product;
    `);
  }
}
