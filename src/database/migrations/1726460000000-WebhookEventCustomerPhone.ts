import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `customer_phone` (nullable text) + a btree index to all four
 * webhook audit tables. Powers the per-row phone column on the
 * Integrations → Events page and the `?phone=` ILIKE search filter.
 *
 * Nullable because:
 *   - Pre-existing rows aren't backfilled — forward-only. They render
 *     as "—" on the UI, honest about what we have.
 *   - Some topics genuinely don't carry phone (e.g. shopify
 *     fulfillment_orders/split is a pre-shipping admin signal).
 *   - Shopify COD-manual orders occasionally miss customer.phone + any
 *     fallback address phone.
 *
 * Index is btree, not trigram. ILIKE %needle% doesn't use a btree
 * index — but the first-pass filter is `phone IS NOT NULL AND
 * platform = X AND received_at < Y`, which the index DOES accelerate,
 * then the ILIKE narrows the already-small result set. Trigram would
 * be the right call once a single table crosses ~1M rows; we're
 * nowhere near that today.
 */
export class WebhookEventCustomerPhone1726460000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE shopify_webhook_event
        ADD COLUMN customer_phone text NULL;
      CREATE INDEX idx_shopify_webhook_event_customer_phone
        ON shopify_webhook_event (customer_phone)
        WHERE customer_phone IS NOT NULL;

      ALTER TABLE lens_webhook_event
        ADD COLUMN customer_phone text NULL;
      CREATE INDEX idx_lens_webhook_event_customer_phone
        ON lens_webhook_event (customer_phone)
        WHERE customer_phone IS NOT NULL;

      ALTER TABLE clickpost_webhook_event
        ADD COLUMN customer_phone text NULL;
      CREATE INDEX idx_clickpost_webhook_event_customer_phone
        ON clickpost_webhook_event (customer_phone)
        WHERE customer_phone IS NOT NULL;

      ALTER TABLE return_prime_webhook_event
        ADD COLUMN customer_phone text NULL;
      CREATE INDEX idx_return_prime_webhook_event_customer_phone
        ON return_prime_webhook_event (customer_phone)
        WHERE customer_phone IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_shopify_webhook_event_customer_phone;
      ALTER TABLE shopify_webhook_event DROP COLUMN customer_phone;

      DROP INDEX IF EXISTS idx_lens_webhook_event_customer_phone;
      ALTER TABLE lens_webhook_event DROP COLUMN customer_phone;

      DROP INDEX IF EXISTS idx_clickpost_webhook_event_customer_phone;
      ALTER TABLE clickpost_webhook_event DROP COLUMN customer_phone;

      DROP INDEX IF EXISTS idx_return_prime_webhook_event_customer_phone;
      ALTER TABLE return_prime_webhook_event DROP COLUMN customer_phone;
    `);
  }
}
