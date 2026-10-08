import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Automation rules: admin-authored "when EVENT → if CONDITIONS → do
 * ACTIONS" definitions. The engine subscribes to a small set of
 * domain events (ticket.created, message.received, tag.applied, …)
 * and dispatches matching rules on each emit.
 *
 * Schema is deliberately minimal:
 *   - cases / else_actions as jsonb → shape evolves without
 *     migrations per new predicate operator or action handler.
 *   - compound index on (event, enabled) → the engine's hot path
 *     is "give me every enabled rule for event X" and that query
 *     drives this index directly.
 *
 * No FKs — rules don't own anything; they reference tags, users,
 * teams by id/name inside the jsonb action payloads. Those are
 * validated at engine dispatch time (action handlers fail soft and
 * log, rather than taking a lock on a cascading FK).
 */
export class AutomationRules1726180000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.automation_rule (
        id            uuid        NOT NULL DEFAULT gen_random_uuid(),
        name          text        NOT NULL,
        description   text                 NULL,
        enabled       boolean     NOT NULL DEFAULT true,
        event         text        NOT NULL,
        cases         jsonb       NOT NULL DEFAULT '[]'::jsonb,
        else_actions  jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "createdAt"   timestamptz NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT automation_rule_pkey PRIMARY KEY (id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_automation_rule_event_enabled
        ON public.automation_rule (event, enabled)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_automation_rule_event_enabled`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.automation_rule`);
  }
}
