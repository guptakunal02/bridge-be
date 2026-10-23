import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit log + idempotency surface for Shopify webhooks.
 *
 * `webhook_id` is unique (Shopify's `X-Shopify-Webhook-Id` header) so
 * a duplicate retry during Shopify's eventual-consistency retries
 * returns 200 instantly without re-emitting the automation event.
 * We treat the UNIQUE constraint as the dedup check — insert first,
 * dispatch on success, 409 → short-circuit to 200.
 *
 * `topic`, `shop_domain`, and `received_at` give the Integrations
 * page enough to render "last event received" + per-topic counts
 * without a second table.
 *
 * `payload` is jsonb — we store the parsed body so support can
 * replay / inspect without needing Shopify to resend. Not indexed;
 * queries are always by webhook_id or by (shop_domain, created_at).
 *
 * No automatic retention. Shopify webhook volume at Surma scale is
 * ~1k events/month; the table stays small for years. If it grows
 * we can add a scheduled truncate for rows older than 90 days.
 */
export class ShopifyWebhookEvent1726340000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shopify_webhook_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id text NOT NULL UNIQUE,
        topic text NOT NULL,
        shop_domain text NOT NULL,
        payload jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_shopify_webhook_event_shop_received
       ON shopify_webhook_event(shop_domain, received_at DESC);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS shopify_webhook_event;`);
  }
}
