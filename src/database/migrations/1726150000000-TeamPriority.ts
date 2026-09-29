import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Team priority — decides which team's routing rules are evaluated
 * first at ingest. Lower value = higher priority (walks 0, 1, 2…
 * until a team's rules match a ticket, otherwise falls through to
 * the default team).
 *
 * Backfill: existing rows get priority 0, 1, 2… in create-order so
 * the "before" and "after" ordering match — no team suddenly wins
 * routes it didn't before. New teams default to a large value so
 * they land at the bottom of the list; admins reorder from the UI.
 */
export class TeamPriority1726150000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.team
        ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 1000
    `);
    // Backfill create-order → priority so today's implicit "all rules
    // scanned, first match wins" behaviour stays continuous when the
    // routing engine flips to priority-ordered team iteration.
    // NB: `team` has no soft-delete column (unlike `ticket`), so
    // every row counts.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) - 1 AS rn
        FROM public.team
      )
      UPDATE public.team t
      SET priority = r.rn
      FROM ranked r
      WHERE t.id = r.id
    `);
    // Ordering index — routing hot path walks by priority ASC.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_team_priority
        ON public.team (priority ASC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_team_priority`);
    await queryRunner.query(`ALTER TABLE public.team DROP COLUMN IF EXISTS priority`);
  }
}
