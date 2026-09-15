import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes routing_rule.priority. The product call is to keep rules
 * equal-weight and rely on admin convention (mutually exclusive
 * conditions) — no priority stacking, matching LimeChat's model.
 *
 * The old (is_active, priority) index is replaced with
 * (is_active, "createdAt") so the evaluator's stable order is still
 * covered.
 */
export class DropRulePriority1726000000000 implements MigrationInterface {
  name = 'DropRulePriority1726000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.routing_rule_active_priority_idx`,
    );
    await queryRunner.query(
      `ALTER TABLE public.routing_rule DROP COLUMN IF EXISTS priority`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS routing_rule_active_createdAt_idx
       ON public.routing_rule (is_active, "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.routing_rule_active_createdAt_idx`,
    );
    await queryRunner.query(
      `ALTER TABLE public.routing_rule ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS routing_rule_active_priority_idx
       ON public.routing_rule (is_active, priority)`,
    );
  }
}
