import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `delay` step type and the per-session `wake_at` wake-up
 * timestamp that drives it.
 *
 *   bot_step_type_enum   gains 'delay'   — DelayStepConfig lives in
 *                                           bot_step.config as before.
 *   bot_session.wake_at  timestamptz NULL — when non-null, the runtime
 *                                           sweep resumes this session
 *                                           at or after that moment.
 *
 * Partial index on (status, wake_at) WHERE wake_at IS NOT NULL keeps
 * the sweep query fast — the vast majority of sessions have NULL
 * wake_at and shouldn't bloat the index.
 *
 * No backfill — existing sessions keep wake_at NULL, which the runtime
 * treats as "not sleeping". Behaviour unchanged for pre-migration rows.
 */
export class BotDelayStep1726290000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres 12+ allows ALTER TYPE ADD VALUE inside a transaction
    // provided the new value isn't used in the same txn. The next
    // statements only touch the sessions table, so this is safe.
    await queryRunner.query(
      `ALTER TYPE public.bot_step_type_enum ADD VALUE IF NOT EXISTS 'delay'`,
    );
    await queryRunner.query(
      `ALTER TABLE public.bot_session
         ADD COLUMN IF NOT EXISTS wake_at timestamptz NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS bot_session_wake_at_idx
         ON public.bot_session (status, wake_at)
         WHERE wake_at IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.bot_session_wake_at_idx`,
    );
    await queryRunner.query(
      `ALTER TABLE public.bot_session DROP COLUMN IF EXISTS wake_at`,
    );
    // Postgres has no DROP VALUE on an enum. Reverting the enum
    // addition requires a full enum rebuild (rename, create new,
    // migrate rows, drop old) which is risky and almost never what
    // down() should do. Any 'delay' rows become orphans on down —
    // acceptable since reverting this migration should only happen
    // on a never-populated branch.
  }
}
