import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retire BotStepType.QUESTION. Its behaviour (message text + reply
 * options) is now folded into MESSAGE — a message with zero options
 * auto-advances, a message with N options waits for a button reply
 * and routes on it.
 *
 * Steps in three parts, all inside a single transaction:
 *   1. Rewrite every existing bot_step row from 'question' to
 *      'message'. The config JSONB shape stays the same — a
 *      question's { text, options[], timeoutSeconds? } is already
 *      a valid message config under the new model.
 *   2. Swap the column type. Postgres can't drop an enum value in
 *      place, so we create a fresh enum without QUESTION, alter
 *      the column, and rename.
 *   3. Drop the stale enum.
 */
export class MergeMessageQuestion1726040000000 implements MigrationInterface {
  name = 'MergeMessageQuestion1726040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE public.bot_step SET type = 'message' WHERE type = 'question'`,
    );
    await queryRunner.query(
      `CREATE TYPE public.bot_step_type_enum_new AS ENUM (
         'message', 'function', 'branch', 'handoff'
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE public.bot_step
         ALTER COLUMN type TYPE public.bot_step_type_enum_new
         USING type::text::public.bot_step_type_enum_new`,
    );
    await queryRunner.query(`DROP TYPE public.bot_step_type_enum`);
    await queryRunner.query(
      `ALTER TYPE public.bot_step_type_enum_new RENAME TO bot_step_type_enum`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reintroducing QUESTION doesn't reverse the data rewrite (we
    // don't know which of the former-questions were actually
    // question-shaped), but adding the enum value back keeps any
    // downstream code that references it from choking.
    await queryRunner.query(
      `CREATE TYPE public.bot_step_type_enum_old AS ENUM (
         'message', 'question', 'function', 'branch', 'handoff'
       )`,
    );
    await queryRunner.query(
      `ALTER TABLE public.bot_step
         ALTER COLUMN type TYPE public.bot_step_type_enum_old
         USING type::text::public.bot_step_type_enum_old`,
    );
    await queryRunner.query(`DROP TYPE public.bot_step_type_enum`);
    await queryRunner.query(
      `ALTER TYPE public.bot_step_type_enum_old RENAME TO bot_step_type_enum`,
    );
  }
}
