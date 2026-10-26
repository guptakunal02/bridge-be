import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2a of the Marketing Messages tooling: lift
 * `whatsapp_template` from body-only to Meta's full component
 * shape — HEADER (text/image), FOOTER text, up to 3 BUTTONS.
 *
 * Purely additive — every pre-existing row ends up with
 * `header_type = NONE`, `header_* = NULL`, `footer_text = NULL`,
 * `buttons = NULL` and keeps working exactly as it did on Phase 1
 * (body-only). Nothing in the ingest / send / variable-resolver
 * paths breaks on an older row.
 *
 * V1 defers VIDEO and DOCUMENT header formats and defers variable
 * references in header_text / buttons / footer. Add those columns
 * / resolver hooks when a merchant asks.
 */
export class WhatsappTemplateRichFields1726380000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE whatsapp_template_header_type_enum AS ENUM (
        'NONE', 'TEXT', 'IMAGE'
      );
    `);
    await queryRunner.query(`
      ALTER TABLE whatsapp_template
        ADD COLUMN header_type whatsapp_template_header_type_enum
          NOT NULL DEFAULT 'NONE',
        ADD COLUMN header_text text NULL,
        ADD COLUMN header_media_handle text NULL,
        ADD COLUMN header_media_url text NULL,
        ADD COLUMN footer_text text NULL,
        ADD COLUMN buttons jsonb NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template
        DROP COLUMN buttons,
        DROP COLUMN footer_text,
        DROP COLUMN header_media_url,
        DROP COLUMN header_media_handle,
        DROP COLUMN header_text,
        DROP COLUMN header_type;
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS whatsapp_template_header_type_enum;`);
  }
}
