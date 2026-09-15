import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rules are now team-agnostic at creation time. The team ↔ rule
 * pairing is made from the team creation modal instead. NULL here
 * means "not yet attached to any team" — such rules are inert until
 * an admin picks them up from the team modal.
 */
export class RuleTeamIdNullable1726010000000 implements MigrationInterface {
  name = 'RuleTeamIdNullable1726010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.routing_rule ALTER COLUMN team_id DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // If any orphaned rules exist we'd need a fallback team here.
    // The default team's id is looked up at migration time; matches
    // the pattern the TeamsAndTicketTeam migration used.
    await queryRunner.query(`
      UPDATE public.routing_rule
      SET team_id = (SELECT id FROM public.team WHERE is_default = true LIMIT 1)
      WHERE team_id IS NULL
    `);
    await queryRunner.query(
      `ALTER TABLE public.routing_rule ALTER COLUMN team_id SET NOT NULL`,
    );
  }
}
