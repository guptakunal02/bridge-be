import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds ticket.tags — a text[] column for free-form labels used by
 * routing rules and by humans to categorise threads.
 *
 * Backed by a GIN index so rule evaluation queries like
 * `tags @> ARRAY['refund']` stay fast even on the tickets table with
 * millions of rows.
 *
 * Legacy rows land with tags = '{}' (the DEFAULT), which cleanly
 * fails any "must contain X" rule without any special-case code.
 */
export class TicketTags1725980000000 implements MigrationInterface {
  name = 'TicketTags1725980000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.ticket
         ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ticket_tags_gin ON public.ticket USING GIN (tags)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.ticket_tags_gin`);
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP COLUMN IF EXISTS tags`,
    );
  }
}
