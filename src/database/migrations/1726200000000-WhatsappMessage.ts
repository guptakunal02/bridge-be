import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the whatsapp_message table (parallel to email_message) + the
 * two most-queried composite indexes (channelId+createdAt for
 * channel-scoped scans, ticket_id+createdAt for the detail view's
 * message list). Reuses the existing MessageDirection enum
 * (SENT / RECEIVED) rather than minting a parallel one — keeps the
 * inbox-agnostic shape the FE eventually consumes.
 */
export class WhatsappMessage1726200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "whatsapp_message" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "channelId" UUID NOT NULL,
        "ticket_id" BIGINT NOT NULL,
        "type" "public"."email_message_type_enum" NOT NULL,
        "sender" TEXT NOT NULL,
        "content" TEXT,
        "external_message_id" TEXT NOT NULL,
        "message_type" TEXT NOT NULL,
        "raw_payload" JSONB,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "whatsapp_message_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "whatsapp_message_external_message_id_unique"
          UNIQUE ("external_message_id"),
        CONSTRAINT "whatsapp_message_channel_fkey"
          FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE,
        CONSTRAINT "whatsapp_message_ticket_fkey"
          FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "whatsapp_message_channel_created_idx"
        ON "whatsapp_message" ("channelId", "createdAt");
    `);
    await queryRunner.query(`
      CREATE INDEX "whatsapp_message_ticket_created_idx"
        ON "whatsapp_message" ("ticket_id", "createdAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "whatsapp_message_ticket_created_idx";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "whatsapp_message_channel_created_idx";`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "whatsapp_message";`);
  }
}
