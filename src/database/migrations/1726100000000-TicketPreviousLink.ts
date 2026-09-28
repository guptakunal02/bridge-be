import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `ticket.previous_ticket_id` — set on the fresh ticket that
 * gets minted when a customer replies to a RESOLVED ticket AFTER
 * the configured reopen window (so it's not a reopen, but not a
 * cold new conversation either).
 *
 * Chain traversal on the detail view walks this backwards and
 * shows the entire ancestor thread with a "New ticket started
 * here" divider at each boundary.
 *
 * ON DELETE SET NULL so removing an old ticket doesn't cascade
 * into the newer one — the chain just breaks at that point and
 * the newer ticket loses its history reference gracefully.
 */
export class TicketPreviousLink1726100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.ticket
        ADD COLUMN IF NOT EXISTS previous_ticket_id bigint NULL
    `);
    await queryRunner.query(`
      ALTER TABLE public.ticket
        ADD CONSTRAINT fk_ticket_previous
        FOREIGN KEY (previous_ticket_id)
        REFERENCES public.ticket (id)
        ON DELETE SET NULL
    `);
    // Traversal is one-direction (child → parent) so an index on the
    // FK is only worth it for the reverse "who continues me" query.
    // Cheap to add now; skip the reverse index until it's used.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ticket_previous_ticket_id
        ON public.ticket (previous_ticket_id)
        WHERE previous_ticket_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_ticket_previous_ticket_id`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP CONSTRAINT IF EXISTS fk_ticket_previous`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket DROP COLUMN IF EXISTS previous_ticket_id`,
    );
  }
}
