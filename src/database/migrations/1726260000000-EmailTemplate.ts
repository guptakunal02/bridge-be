import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V8a — email templates. Mirror of whatsapp_template structure but
 * without the Meta review lifecycle (no status column, no
 * meta_template_id, no rejection_reason). Email templates are
 * immediately usable once saved.
 *
 * Shape:
 *   id              uuid PK
 *   number          bigserial (public identifier for Outreach URLs)
 *   channel_id      uuid FK → channel (per-channel scoping so each
 *                   sending identity can carry its own tone / signature)
 *   name            text (snake_case internal id, unique per channel)
 *   category        UTILITY | MARKETING  (V1 only exposes UTILITY)
 *   subject         text with {{name}} placeholders
 *   body_html       text with {{name}} placeholders
 *   body_text       text, nullable — optional plain fallback
 *   variable_count  int derived
 *   variable_mapping jsonb, nullable (same shape as whatsapp_template)
 *   created_by      uuid FK → user, SET NULL on member delete
 */
export class EmailTemplate1726260000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "email_template_category_enum" AS ENUM (
        'UTILITY', 'MARKETING'
      );
    `);
    await queryRunner.query(`
      CREATE SEQUENCE IF NOT EXISTS "email_template_number_seq";
    `);
    await queryRunner.query(`
      CREATE TABLE "email_template" (
        "id"               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
        "number"           BIGINT      NOT NULL DEFAULT nextval('email_template_number_seq'),
        "channel_id"       UUID        NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
        "name"             TEXT        NOT NULL,
        "category"         "email_template_category_enum" NOT NULL DEFAULT 'UTILITY',
        "subject"          TEXT        NOT NULL,
        "body_html"        TEXT        NOT NULL,
        "body_text"        TEXT,
        "variable_count"   INT         NOT NULL DEFAULT 0,
        "variable_mapping" JSONB,
        "created_by"       UUID        REFERENCES "user"("id") ON DELETE SET NULL,
        "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_email_template_number" UNIQUE ("number")
      );
    `);
    await queryRunner.query(`
      ALTER SEQUENCE "email_template_number_seq"
        OWNED BY "email_template"."number";
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_email_template_channel_name"
        ON "email_template" ("channel_id", "name");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_email_template_channel_category"
        ON "email_template" ("channel_id", "category");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "email_template";`);
    await queryRunner.query(
      `DROP SEQUENCE IF EXISTS "email_template_number_seq";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "email_template_category_enum";`,
    );
  }
}
