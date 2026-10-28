import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `lens_webhook_event` — dedup + audit log for Lens-forwarded delivery
 * exception events (NDR / NPR). Lens POSTs with a stable event_id
 * (reused from its LimeChat idempotency key), so retries land on the
 * UNIQUE constraint and we short-circuit without re-emitting.
 */
export class LensWebhookEvent1726430000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS lens_webhook_event (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        event_id text NOT NULL UNIQUE,
        topic text NOT NULL,
        payload jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_lens_webhook_event_received_at
       ON lens_webhook_event(received_at DESC);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_lens_webhook_event_topic_received_at
       ON lens_webhook_event(topic, received_at DESC);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS lens_webhook_event;`);
  }
}
