import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2b of the Marketing Messages tooling: per-template bid cap
 * for Meta's Max Price feature. Admins configure "never charge
 * more than ₹X per 1,000 marketing deliveries"; the sender injects
 * that as `optimization_spec` on the Meta send call.
 *
 * Storage unit: smallest currency unit (paisa for INR) per 1,000
 * deliveries — matches Meta's `bid_amount` wire format exactly.
 * Nullable because:
 *   * UTILITY / AUTHENTICATION templates can't use max price (Meta
 *     restricts the feature to MARKETING).
 *   * Admins may want to send at Meta's default auction price —
 *     NULL preserves pre-Phase-2b behaviour for every existing row.
 *
 * No currency column — Surma is INR-only in V1. When we add
 * multi-currency, add it then as a sibling column.
 */
export class WhatsappTemplateMaxPrice1726390000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template
        ADD COLUMN max_price_amount bigint NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_template DROP COLUMN max_price_amount;
    `);
  }
}
