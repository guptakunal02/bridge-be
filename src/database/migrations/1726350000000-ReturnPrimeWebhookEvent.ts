import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit log for inbound Return Prime webhooks. Mirrors the shape of
 * shopify_webhook_event (same persistence + inspector + idempotency
 * story) but on a separate table so cross-platform queries stay
 * explicit and per-platform retention is independent.
 *
 * webhook_id source: Return Prime doesn't send a dedicated event id
 * header. We derive one at receive time from the body (request id +
 * topic + updatedAt or similar); if that derivation yields nothing
 * unique, we fall back to a hash of the raw body. The UNIQUE on
 * webhook_id prevents double-processing of retries without any
 * cooperation from RP.
 */
export class ReturnPrimeWebhookEvent1726350000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS return_prime_webhook_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id text NOT NULL UNIQUE,
        topic text NOT NULL,
        payload jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_return_prime_webhook_event_received_at
       ON return_prime_webhook_event(received_at DESC);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS return_prime_webhook_event;`,
    );
  }
}
