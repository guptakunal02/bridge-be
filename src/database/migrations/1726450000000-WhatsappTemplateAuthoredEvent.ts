import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Follow-up to 1726440000000 — adds the `authored_event` column on
 * whatsapp_template. Split into its own migration because the first
 * one already shipped + applied in prod before the FE realized it
 * also needed to persist which event the admin picked at authoring
 * time. Editing the earlier file would've been a no-op in prod
 * (TypeORM records migrations by timestamp + skips re-runs).
 *
 * Nullable: existing rows have never carried this metadata, and we
 * never gate send-time dispatch on it — purely a UX convenience that
 * lets the automation editor pre-select the rule's trigger to the
 * event the template was authored against.
 */
export class WhatsappTemplateAuthoredEvent1726450000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template
        ADD COLUMN authored_event text NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template DROP COLUMN authored_event;
    `);
  }
}
