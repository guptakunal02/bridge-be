import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit log + idempotency surface for Clickpost webhooks. Mirrors
 * the Shopify + Return Prime pattern.
 *
 * Clickpost doesn't send a dedicated event id, so the service
 * derives one from (waybill + clickpost_status_code + timestamp)
 * — same shipment + same status code + same scan time = same event.
 * Falls back to a sha256 of the raw body for payloads missing those
 * fields. UNIQUE on webhook_id catches retries at insert time.
 */
export class ClickpostWebhookEvent1726360000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS clickpost_webhook_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id text NOT NULL UNIQUE,
        status text NOT NULL,
        waybill text NULL,
        order_id text NULL,
        payload jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_clickpost_webhook_event_received_at
       ON clickpost_webhook_event(received_at DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_clickpost_webhook_event_order_id
       ON clickpost_webhook_event(order_id) WHERE order_id IS NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS clickpost_webhook_event;`);
  }
}
