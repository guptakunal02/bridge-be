import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add three nullable columns to whatsapp_message so SENT media rows
 * carry enough info for the FE to render a clickable attachment
 * card (filename + size + mime + link):
 *
 *   media_url        text        — public S3 URL (same bucket as
 *                                   email attachments)
 *   media_mime_type  text        — e.g. "application/pdf"
 *   media_size_bytes bigint      — file size for the "48 kB" label
 *
 * All nullable because:
 *   * RECEIVED messages don't go through our upload path, so we
 *     don't have an S3 URL for them yet (V5 slice: download Meta's
 *     media id to S3 on ingest).
 *   * Historical SENT rows (before V4b) have no URL either — the
 *     bytes still live in S3 under the storage_key we persisted at
 *     upload time, but we never captured the URL on the row.
 *
 * No index — these columns aren't queried, only read when rendering
 * a single detail view's message array.
 */
export class WhatsappMessageMedia1726220000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "whatsapp_message"
        ADD COLUMN "media_url"        TEXT,
        ADD COLUMN "media_mime_type"  TEXT,
        ADD COLUMN "media_size_bytes" BIGINT;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "whatsapp_message"
        DROP COLUMN IF EXISTS "media_size_bytes",
        DROP COLUMN IF EXISTS "media_mime_type",
        DROP COLUMN IF EXISTS "media_url";
    `);
  }
}
