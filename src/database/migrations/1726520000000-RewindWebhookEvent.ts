import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit table for inbound Rewind (loyalty) webhooks. Drives idempotency
 * on retries + the Integrations page "last event received" display.
 *
 * `webhook_id` is the dedup key. Rewind's shared body shape has no
 * stable event id field, so the service synthesizes one as a sha256
 * over the whole body — byte-identical retries dedup, distinct events
 * don't.
 */
export class RewindWebhookEvent1726520000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "rewind_webhook_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "webhook_id" text NOT NULL,
        "event_type" text NOT NULL,
        "payload" jsonb NOT NULL,
        "customer_phone" text NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_rewind_webhook_event" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_rewind_webhook_event_webhook_id" UNIQUE ("webhook_id")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_rewind_webhook_event_received_at" ON "rewind_webhook_event" ("received_at");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rewind_webhook_event_type_at" ON "rewind_webhook_event" ("event_type", "received_at");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rewind_webhook_event_type_at";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rewind_webhook_event_received_at";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "rewind_webhook_event";`);
  }
}
