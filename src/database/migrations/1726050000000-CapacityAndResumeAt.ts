import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduces per-member ticket capacity and the timer field that
 * drives waiting / followup auto-transitions.
 *
 *   team_member.max_concurrent_tickets  int NOT NULL default 5
 *     Only OPEN tickets count against this — WAITING and IN_FOLLOWUP
 *     don't burn capacity. When an agent frees a slot (resolve /
 *     waiting / followup), the capacity-backfill hook first drains
 *     the agent's own ripe followup tickets, then pulls the oldest
 *     BOT-queued ticket in any team they belong to.
 *
 *   ticket.resume_at  timestamptz NULL
 *     Non-null only when status is WAITING or IN_FOLLOWUP. Cron
 *     sweeps this every minute:
 *       WAITING + resume_at < NOW()  → auto-transition to RESOLVED
 *       IN_FOLLOWUP + resume_at < NOW() → stays IN_FOLLOWUP, but
 *         becomes "ripe" so the capacity hook can wake it into OPEN
 *         next time the assignee frees a slot.
 *     A ticket returning to OPEN (customer reply or ripe drain)
 *     clears this back to NULL.
 */
export class CapacityAndResumeAt1726050000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.team_member
       ADD COLUMN IF NOT EXISTS max_concurrent_tickets integer NOT NULL DEFAULT 5`,
    );
    // Guardrail: the picker treats zero as "never eligible" — a stale
    // 0 in the DB would silently take an agent out of rotation forever.
    // Enforce at schema level so no manual UPDATE can break assignment.
    await queryRunner.query(
      `ALTER TABLE public.team_member
       DROP CONSTRAINT IF EXISTS chk_team_member_cap_positive`,
    );
    await queryRunner.query(
      `ALTER TABLE public.team_member
       ADD CONSTRAINT chk_team_member_cap_positive
       CHECK (max_concurrent_tickets >= 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket
       ADD COLUMN IF NOT EXISTS resume_at timestamptz NULL`,
    );
    // Invariant: only WAITING / IN_FOLLOWUP tickets carry a timer.
    // Any other status must have resume_at NULL — otherwise the sweep
    // could target a RESOLVED ticket and re-open it, and the assignee
    // ratio math for capacity would be meaningless. Enforced here so
    // even direct SQL edits can't drift out of sync with the code.
    await queryRunner.query(
      `ALTER TABLE public.ticket
       DROP CONSTRAINT IF EXISTS chk_ticket_resume_at_status`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket
       ADD CONSTRAINT chk_ticket_resume_at_status
       CHECK (
         (status IN ('WAITING', 'IN_FOLLOWUP')) OR resume_at IS NULL
       )`,
    );
    // Partial index — only tickets that are actually paused have a
    // resume_at, so we skip indexing the (much larger) NULL majority.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_ticket_resume_at_ripe
       ON public.ticket (resume_at)
       WHERE resume_at IS NOT NULL`,
    );
    // Composite index for the capacity check subquery in the picker
    // (`assignee = X AND team_id = Y AND status = OPEN`) and for the
    // per-member load count in TeamsService. Partial on live rows so
    // the index stays lean as tickets accumulate.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_ticket_assignee_team_status
       ON public.ticket (assignee, team_id, status)
       WHERE "deletedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_ticket_assignee_team_status`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_ticket_resume_at_ripe`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP CONSTRAINT IF EXISTS chk_ticket_resume_at_status`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP COLUMN IF EXISTS resume_at`,
    );
    await queryRunner.query(
      `ALTER TABLE public.team_member DROP CONSTRAINT IF EXISTS chk_team_member_cap_positive`,
    );
    await queryRunner.query(
      `ALTER TABLE public.team_member DROP COLUMN IF EXISTS max_concurrent_tickets`,
    );
  }
}
