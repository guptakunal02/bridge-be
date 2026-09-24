import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two changes that together back the "reopen resolved ticket if
 * the customer replies quickly" rule:
 *
 * 1. `ticket.resolved_at` — nullable timestamp set when a ticket
 *    transitions to RESOLVED, cleared on any transition away.
 *    Lets the ingest path do a cheap `now() - resolved_at < window`
 *    check without walking the activity log per email.
 *    Backfilled from the latest MARKED_RESOLVED activity row so
 *    existing resolved tickets participate on day one.
 *
 * 2. `app_setting` — key/value settings store. Seeded with
 *    `resolved_reopen_window_hours = 2` so the rule has a sane
 *    default. Room to grow into other admin toggles without
 *    another migration per setting.
 */
export class ResolvedReopenWindow1726090000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. resolved_at on ticket
    await queryRunner.query(`
      ALTER TABLE public.ticket
        ADD COLUMN IF NOT EXISTS resolved_at timestamptz NULL
    `);
    await queryRunner.query(`
      UPDATE public.ticket t
         SET resolved_at = sub.last_resolved
        FROM (
          SELECT ticket_id, MAX("createdAt") AS last_resolved
            FROM public.ticket_activity_log
           WHERE event = 'MARKED_RESOLVED'
           GROUP BY ticket_id
        ) sub
       WHERE t.id = sub.ticket_id
         AND t.status = 'RESOLVED'
         AND t.resolved_at IS NULL
    `);
    // Partial index — only resolved rows carry a value, and the
    // ingest lookup filters on status = RESOLVED + resolved_at
    // window. Keeps the index tiny.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ticket_resolved_at
        ON public.ticket (resolved_at)
        WHERE resolved_at IS NOT NULL
    `);

    // 2. app_setting key/value store
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.app_setting (
        key         text        NOT NULL,
        value       text        NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT app_setting_pkey PRIMARY KEY (key)
      )
    `);
    await queryRunner.query(`
      INSERT INTO public.app_setting (key, value)
      VALUES ('resolved_reopen_window_hours', '2')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.app_setting`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_ticket_resolved_at`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP COLUMN IF EXISTS resolved_at`,
    );
  }
}
