import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V7a — introduces the whatsapp_template table so agents can re-engage
 * customers after the 24h customer-service window closes. Composer's
 * "Send template" picker reads APPROVED rows for the ticket's channel;
 * settings page lists all rows + lets any member create new ones.
 *
 * Design notes:
 *   * Enums are Meta's own category + review-status strings — we mirror
 *     them 1:1 so a sync pass can map Meta's response directly without
 *     a translation layer.
 *   * (channel_id, name, language) is unique — Meta allows multiple
 *     language variants of the same template name; each is its own row.
 *   * ON DELETE CASCADE on channel_id — losing the channel means these
 *     templates can't be sent anyway, so garbage-collect them with the
 *     parent.
 *   * ON DELETE SET NULL on created_by — if the member who authored
 *     the template leaves the workspace we still want to keep the
 *     template usable; we just lose the audit arrow.
 */
export class WhatsappTemplate1726230000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "whatsapp_template_category_enum" AS ENUM (
        'UTILITY', 'MARKETING', 'AUTHENTICATION'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE "whatsapp_template_status_enum" AS ENUM (
        'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'
      );
    `);
    await queryRunner.query(`
      CREATE TABLE "whatsapp_template" (
        "id"                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        "channel_id"         UUID        NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
        "name"               TEXT        NOT NULL,
        "category"           "whatsapp_template_category_enum" NOT NULL,
        "language"           TEXT        NOT NULL DEFAULT 'en',
        "body"               TEXT        NOT NULL,
        "variable_count"     INT         NOT NULL DEFAULT 0,
        "status"             "whatsapp_template_status_enum" NOT NULL DEFAULT 'PENDING',
        "meta_template_id"   TEXT,
        "rejection_reason"   TEXT,
        "created_by"         UUID        REFERENCES "user"("id") ON DELETE SET NULL,
        "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_whatsapp_template_channel_name_lang"
        ON "whatsapp_template" ("channel_id", "name", "language");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_whatsapp_template_channel_status"
        ON "whatsapp_template" ("channel_id", "status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "whatsapp_template";`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "whatsapp_template_status_enum";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "whatsapp_template_category_enum";`,
    );
  }
}
