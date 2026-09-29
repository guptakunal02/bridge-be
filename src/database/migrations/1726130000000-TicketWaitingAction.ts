import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-ticket policy for what happens when the WAITING timer elapses
 * with no customer reply. Historically the sweep always resolved,
 * which was too aggressive for follow-up-heavy workflows — an admin
 * may want the ticket back in their queue instead of silently closed.
 *
 *   AUTO_RESOLVE  — current behaviour: RESOLVED + resolved_at set +
 *                   MARKED_RESOLVED activity.
 *   REOPEN        — status flips back to OPEN, is_reopened stays as
 *                   it was (this isn't a customer-triggered reopen),
 *                   resume_at cleared, REOPENED activity.
 *
 * NULL is treated as AUTO_RESOLVE at read time for backward compat
 * with rows created before the picker landed. New rows entering
 * WAITING always set this explicitly. Rows in other statuses leave
 * the column at NULL — cleaned up any time the ticket transitions
 * away from WAITING.
 */
export class TicketWaitingAction1726130000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE public.ticket_waiting_action_enum
          AS ENUM ('AUTO_RESOLVE', 'REOPEN');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE public.ticket
        ADD COLUMN IF NOT EXISTS waiting_action
          public.ticket_waiting_action_enum NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.ticket DROP COLUMN IF EXISTS waiting_action
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS public.ticket_waiting_action_enum`,
    );
  }
}
