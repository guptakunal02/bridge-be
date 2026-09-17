import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds canvas_position to bot_step for the visual flow-builder
 * canvas. Backfills existing steps as a single vertical column so
 * the new UI doesn't blow up on legacy rows.
 *
 * The `position` column stays — the runtime still uses it as a
 * stable ordering key for the "linear next" fallback when a message
 * / function step has no explicit nextStepId. Canvas rendering only
 * reads canvas_position.
 */
export class BotStepCanvasPosition1726030000000 implements MigrationInterface {
  name = 'BotStepCanvasPosition1726030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.bot_step
         ADD COLUMN IF NOT EXISTS canvas_position jsonb NOT NULL DEFAULT '{"x": 0, "y": 0}'`,
    );
    // Legacy rows: stack vertically at x=0, spaced 180px apart.
    await queryRunner.query(
      `UPDATE public.bot_step
         SET canvas_position = jsonb_build_object('x', 0, 'y', position * 180)
         WHERE canvas_position = '{"x": 0, "y": 0}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.bot_step DROP COLUMN IF EXISTS canvas_position`,
    );
  }
}
