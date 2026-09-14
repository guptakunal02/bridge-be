import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reverse an earlier design call: BOT is now a first-class team
 * member, not a special user we exclude from teams. Every team gets
 * BOT automatically, and admins can toggle its "assign tickets"
 * switch just like any other member. If BOT is paused_in_team and
 * no live agents are Online, the picker throws — ingest retries.
 *
 * This migration:
 *   - Adds the BOT user to every existing team.
 *   - Is idempotent via ON CONFLICT DO NOTHING; safe to re-run.
 */
export class BotJoinsGeneralTeam1725970000000 implements MigrationInterface {
  name = 'BotJoinsGeneralTeam1725970000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO public.team_member (team_id, user_id)
      SELECT t.id, u.id
      FROM public.team t
      CROSS JOIN public."user" u
      WHERE u.role = 'BOT'
        AND u."deactivatedAt" IS NULL
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM public.team_member
      WHERE user_id IN (SELECT id FROM public."user" WHERE role = 'BOT')
    `);
  }
}
