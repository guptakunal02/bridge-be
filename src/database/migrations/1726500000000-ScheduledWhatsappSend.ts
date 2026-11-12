import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backing table for the "send WhatsApp template after X hours"
 * automation feature. Rows represent queued dispatches — written by
 * ActionDispatcher when a matched action has delay_minutes > 0,
 * drained by ScheduledWhatsappSendWorker on a 1-min poll.
 *
 * Index target: worker SELECT is always WHERE status='PENDING' AND
 * scheduled_at <= NOW() — a composite on (status, scheduled_at)
 * covers it cheaply at any table size.
 */
export class ScheduledWhatsappSend1726500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "scheduled_send_status" AS ENUM ('PENDING', 'SENT', 'FAILED');
    `);
    await queryRunner.query(`
      CREATE TABLE "scheduled_whatsapp_send" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "rule_id" uuid NULL,
        "action_config" jsonb NOT NULL,
        "event_ctx" jsonb NOT NULL,
        "scheduled_at" timestamptz NOT NULL,
        "status" "scheduled_send_status" NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text NULL,
        "sent_at" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scheduled_whatsapp_send" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_scheduled_whatsapp_send_status_at"
        ON "scheduled_whatsapp_send" ("status", "scheduled_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scheduled_whatsapp_send_status_at";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "scheduled_whatsapp_send";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "scheduled_send_status";`);
  }
}
