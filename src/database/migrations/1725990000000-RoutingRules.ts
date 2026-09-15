import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 3 routing engine: adds routing_rule.
 *
 *   name             — unique, human-readable ("OOH Tickets")
 *   team_id          — where matches get routed
 *   condition_tree   — JSONB: { groups: [ { conditions: [...] } ] }
 *                      OR at group level, AND within a group
 *   priority         — evaluation order ASC; first match wins
 *   is_active        — pause a rule without losing its definition
 *
 * Composite index on (is_active, priority) so the evaluator's
 * `WHERE is_active = true ORDER BY priority ASC` stays index-only.
 */
export class RoutingRules1725990000000 implements MigrationInterface {
  name = 'RoutingRules1725990000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.routing_rule (
        id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
        name            text         NOT NULL,
        team_id         uuid         NOT NULL,
        condition_tree  jsonb        NOT NULL,
        priority        integer      NOT NULL DEFAULT 100,
        is_active       boolean      NOT NULL DEFAULT true,
        "createdAt"     timestamptz  NOT NULL DEFAULT NOW(),
        "updatedAt"     timestamptz  NOT NULL DEFAULT NOW(),
        CONSTRAINT routing_rule_name_uniq UNIQUE (name),
        CONSTRAINT routing_rule_team_fk FOREIGN KEY (team_id)
          REFERENCES public.team (id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS routing_rule_active_priority_idx
       ON public.routing_rule (is_active, priority)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.routing_rule_active_priority_idx`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.routing_rule CASCADE`);
  }
}
