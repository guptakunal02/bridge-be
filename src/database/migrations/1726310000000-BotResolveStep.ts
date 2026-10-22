import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `resolve` to the bot_step_type_enum. Terminal step type that
 * marks the ticket RESOLVED when the runtime hits it — complements
 * Handoff (hands to a human) with Close (ends the conversation
 * cleanly after a self-service branch).
 *
 * No table changes; config lives in bot_step.config as before.
 * IF NOT EXISTS makes the migration re-runnable.
 */
export class BotResolveStep1726310000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE public.bot_step_type_enum ADD VALUE IF NOT EXISTS 'resolve'`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Postgres has no DROP VALUE on an enum. Reverting an enum
    // addition requires a full rebuild (rename, create new, migrate
    // rows, drop old) which is risky and almost never what down()
    // should do. Any 'resolve' rows become orphans on down —
    // acceptable since reverting this migration should only happen
    // on a never-populated branch.
  }
}
