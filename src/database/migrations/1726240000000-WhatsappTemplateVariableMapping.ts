import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V7b — bolts a `variable_mapping` jsonb column onto whatsapp_template
 * so Bridge-authored templates can carry their named-variable list
 * (first_name, order_id, …) + per-variable fallback strings
 * alongside the Meta-positional body that Meta's API expects.
 *
 * Shape in the column (nullable):
 *   null                        — legacy / imported-from-Meta row
 *   [ { "name": "first_name",   // registry key
 *       "fallback": "there" },  // used when the resolver hits null
 *     { "name": "order_id",     // in-order mapping to {{1}}, {{2}}, …
 *       "fallback": "your order" } ]
 *
 * Nullability matters: templates synced from Meta BM don't carry
 * names — their body is already positional {{1}}, {{2}}. Composer
 * treats those as "legacy" and keeps the positional fill UX.
 */
export class WhatsappTemplateVariableMapping1726240000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "whatsapp_template"
        ADD COLUMN "variable_mapping" JSONB;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "whatsapp_template"
        DROP COLUMN IF EXISTS "variable_mapping";
    `);
  }
}
