import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V7c — adds a short integer `number` to every WhatsApp template so
 * authors + agents can cite templates as "#4" instead of a UUID.
 * The number is the public identifier used in:
 *   * Outreach > WhatsApp list rows (shown next to the name)
 *   * The template detail URL (/outreach/whatsapp/templates/4)
 *   * The composer's slash picker filter — "/4" jumps straight to
 *     template #4, "/restart" still filters by name
 *
 * Implementation:
 *   * BIGSERIAL — unique auto-incrementing integer scoped to the
 *     whatsapp_template table (not per-channel, so numbers never
 *     collide across channels; cleaner than ambiguous "channel A's
 *     #4 vs channel B's #4").
 *   * Backfill existing rows in insert order (ctid proxy for
 *     oldest-first) so already-synced templates get stable numbers
 *     without a second deploy pass.
 */
export class WhatsappTemplateNumber1726250000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add nullable column first, backfill, then set NOT NULL + unique
    // in a single pass — safer than defaulting to a sequence on a
    // table that already has rows.
    await queryRunner.query(`
      ALTER TABLE "whatsapp_template"
        ADD COLUMN "number" BIGINT;
    `);
    await queryRunner.query(`
      CREATE SEQUENCE IF NOT EXISTS "whatsapp_template_number_seq"
        OWNED BY "whatsapp_template"."number";
    `);
    // Backfill: existing rows get sequential ids ordered by created_at
    // (oldest = #1) so the sort stays intuitive.
    await queryRunner.query(`
      UPDATE "whatsapp_template" t
      SET "number" = sub.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) AS rn
        FROM "whatsapp_template"
      ) sub
      WHERE t.id = sub.id;
    `);
    // Advance the sequence past the backfilled values so the next
    // insert picks up where we left off.
    await queryRunner.query(`
      SELECT setval(
        'whatsapp_template_number_seq',
        COALESCE((SELECT MAX("number") FROM "whatsapp_template"), 0) + 1,
        false
      );
    `);
    await queryRunner.query(`
      ALTER TABLE "whatsapp_template"
        ALTER COLUMN "number" SET DEFAULT nextval('whatsapp_template_number_seq'),
        ALTER COLUMN "number" SET NOT NULL,
        ADD CONSTRAINT "UQ_whatsapp_template_number" UNIQUE ("number");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "whatsapp_template"
        DROP CONSTRAINT IF EXISTS "UQ_whatsapp_template_number";
    `);
    await queryRunner.query(`
      ALTER TABLE "whatsapp_template"
        DROP COLUMN IF EXISTS "number";
    `);
    await queryRunner.query(`
      DROP SEQUENCE IF EXISTS "whatsapp_template_number_seq";
    `);
  }
}
