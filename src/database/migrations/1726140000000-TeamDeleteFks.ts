import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Loosens the FKs that pointed at `team` so a team can actually be
 * deleted through the admin UI:
 *
 *   routing_rule.team_id  CASCADE → SET NULL
 *     Rules survive team deletion. Their team_id nulls out and the
 *     routing engine already skips rules with team_id IS NULL, so
 *     the rule becomes inert until an admin re-assigns it to another
 *     team. This makes rules reusable across teams — the sensible
 *     model going forward.
 *
 *   ticket.team_id — kept NO ACTION at the DB level. The service
 *     layer (teams.remove) now reassigns any tickets on the deleted
 *     team to the default team FIRST, so the delete never violates
 *     the FK. Doing it in code (not CASCADE / SET NULL at the DB)
 *     keeps the semantics explicit and auditable — no ticket ever
 *     silently loses its team_id.
 */
export class TeamDeleteFks1726140000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Find the current constraint name — TypeORM auto-generates
    // FK names so hard-coding is brittle across environments.
    const rows: Array<{ conname: string }> = await queryRunner.query(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      WHERE c.contype = 'f'
        AND rel.relname = 'routing_rule'
        AND ref.relname = 'team'
    `);
    for (const r of rows) {
      await queryRunner.query(
        `ALTER TABLE public.routing_rule DROP CONSTRAINT "${r.conname}"`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE public.routing_rule
        ADD CONSTRAINT fk_routing_rule_team
        FOREIGN KEY (team_id)
        REFERENCES public.team (id)
        ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ conname: string }> = await queryRunner.query(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      WHERE c.contype = 'f'
        AND rel.relname = 'routing_rule'
        AND ref.relname = 'team'
    `);
    for (const r of rows) {
      await queryRunner.query(
        `ALTER TABLE public.routing_rule DROP CONSTRAINT "${r.conname}"`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE public.routing_rule
        ADD CONSTRAINT fk_routing_rule_team
        FOREIGN KEY (team_id)
        REFERENCES public.team (id)
        ON DELETE CASCADE
    `);
  }
}
