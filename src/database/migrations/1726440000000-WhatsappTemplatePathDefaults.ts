import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 UX simplification — templates carry default JSON paths for
 * recipient phone + per-event image URL, captured when the admin
 * clicks fields on the event-sample tree during template authoring.
 *
 * Both nullable: existing templates have no stored paths (admin typed
 * `{{var}}` manually or synced from Meta BM); templates where the
 * admin uses the authoring JSON-tree click path fill them in going
 * forward.
 *
 * Automation rules inherit these defaults when the admin picks the
 * template — the rule editor hides its per-field binding UI entirely
 * when defaults cover everything, and surfaces an "Advanced" expand
 * for rules that need a non-standard override.
 *
 * `path` on variableMapping entries (per-variable JSON path) rides
 * on the existing `variable_mapping` jsonb column — no schema change
 * needed for that one, just a type extension on the TS side.
 */
export class WhatsappTemplatePathDefaults1726440000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template
        ADD COLUMN recipient_phone_path text NULL,
        ADD COLUMN header_image_path text NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template
        DROP COLUMN header_image_path,
        DROP COLUMN recipient_phone_path;
    `);
  }
}
