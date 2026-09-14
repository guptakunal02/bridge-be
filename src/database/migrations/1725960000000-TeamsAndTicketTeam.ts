import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 2 schema:
 *   - team              (routing bucket)
 *   - team_member       (User ↔ Team, with paused_in_team switch)
 *   - ticket.team_id    (which bucket this ticket belongs to)
 *
 * Seeds:
 *   - one "General" team with is_default = true
 *   - every non-BOT, non-deactivated user auto-added to it
 *   - every existing ticket rewritten to point at General
 *
 * A partial unique index enforces "at most one default team" without
 * blocking multiple non-default rows.
 */
export class TeamsAndTicketTeam1725960000000 implements MigrationInterface {
  name = 'TeamsAndTicketTeam1725960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.team (
        id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        name               text          NOT NULL,
        is_default         boolean       NOT NULL DEFAULT false,
        assignment_paused  boolean       NOT NULL DEFAULT false,
        "createdAt"        timestamptz   NOT NULL DEFAULT NOW(),
        "updatedAt"        timestamptz   NOT NULL DEFAULT NOW(),
        CONSTRAINT team_name_uniq UNIQUE (name)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS team_only_one_default
        ON public.team (is_default) WHERE is_default = true
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.team_member (
        team_id          uuid          NOT NULL,
        user_id          uuid          NOT NULL,
        paused_in_team   boolean       NOT NULL DEFAULT false,
        "createdAt"      timestamptz   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (team_id, user_id),
        CONSTRAINT team_member_team_fk FOREIGN KEY (team_id)
          REFERENCES public.team (id) ON DELETE CASCADE,
        CONSTRAINT team_member_user_fk FOREIGN KEY (user_id)
          REFERENCES public."user" (id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS team_member_user_idx ON public.team_member (user_id)`,
    );

    // Seed the General team + populate every eligible user.
    await queryRunner.query(`
      INSERT INTO public.team (name, is_default)
      VALUES ('General', true)
      ON CONFLICT (name) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO public.team_member (team_id, user_id)
      SELECT t.id, u.id
      FROM public.team t
      CROSS JOIN public."user" u
      WHERE t.is_default = true
        AND u.role <> 'BOT'
        AND u."deactivatedAt" IS NULL
      ON CONFLICT DO NOTHING
    `);

    // Add ticket.team_id as nullable first so we can backfill, then
    // set NOT NULL once every row points at General.
    await queryRunner.query(`
      ALTER TABLE public.ticket ADD COLUMN IF NOT EXISTS team_id uuid
    `);
    await queryRunner.query(`
      UPDATE public.ticket t
      SET team_id = (SELECT id FROM public.team WHERE is_default = true LIMIT 1)
      WHERE t.team_id IS NULL
    `);
    await queryRunner.query(
      `ALTER TABLE public.ticket ALTER COLUMN team_id SET NOT NULL`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ticket_team_fk'
        ) THEN
          ALTER TABLE public.ticket
            ADD CONSTRAINT ticket_team_fk FOREIGN KEY (team_id)
              REFERENCES public.team (id);
        END IF;
      END $$
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ticket_team_status_idx ON public.ticket (team_id, status)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.ticket_team_status_idx`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP CONSTRAINT IF EXISTS ticket_team_fk`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP COLUMN IF EXISTS team_id`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.team_member CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.team CASCADE`);
  }
}
