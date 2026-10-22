import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `channel_types text[]` to automation_rule for per-channel
 * scoping. Semantic (locked in with the admin): empty array means
 * the rule fires on NO channel — strict opt-in. Existing rows get
 * the default empty array, which deactivates them until re-saved
 * via the editor with explicit channel checkboxes. The admin
 * accepted this backfill behaviour over a "preserve current
 * firing" blanket backfill.
 */
export class AutomationChannelTypes1726320000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE automation_rule ADD COLUMN IF NOT EXISTS channel_types text[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE automation_rule DROP COLUMN IF EXISTS channel_types`,
    );
  }
}
