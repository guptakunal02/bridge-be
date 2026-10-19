import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separates the Bridge-internal label on a channel from the sender
 * display name customers see in their email client's From: field.
 *
 * Before this slice, `displayName` served both roles — fine for a
 * single sending identity, awkward once a workspace runs multiple
 * email channels (support@, utility@, marketing@) that all represent
 * the same brand. Each channel wants its own internal label (so
 * agents can tell them apart in the sidebar) while the customer-
 * facing From should stay unified ("Surma" regardless of which
 * channel sent).
 *
 *   displayName          → Bridge-internal label (unchanged)
 *   senderDisplayName    → From: display name shown to customers
 *                          (nullable; EmailSenderService falls back
 *                          to displayName when null)
 */
export class ChannelSenderDisplayName1726270000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "channel"
        ADD COLUMN "sender_display_name" TEXT;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "channel"
        DROP COLUMN IF EXISTS "sender_display_name";
    `);
  }
}
