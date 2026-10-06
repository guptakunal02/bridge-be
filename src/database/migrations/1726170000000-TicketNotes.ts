import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Internal notes on tickets — admins and members post private
 * commentary that renders inline in the conversation thread.
 * Never leaves the system (no SMTP), never shown to the customer.
 *
 * Immutable in V1: the service layer rejects edits + deletes. If
 * that constraint relaxes later, add a deleted_at column rather
 * than hard-deleting — notes may be the only record of a decision
 * the team made about a case.
 *
 * FK semantics:
 *   - ticket_id ON DELETE CASCADE: notes don't outlive the ticket.
 *   - author_id ON DELETE SET NULL: a deactivated user shouldn't
 *     erase the note (which stays part of the ticket's history).
 *     FE renders "Unknown user" in that case.
 */
export class TicketNotes1726170000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.ticket_note (
        id          uuid        NOT NULL DEFAULT gen_random_uuid(),
        ticket_id   bigint      NOT NULL,
        author_id   uuid                 NULL,
        body        text        NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ticket_note_pkey PRIMARY KEY (id),
        CONSTRAINT fk_ticket_note_ticket
          FOREIGN KEY (ticket_id)
          REFERENCES public.ticket (id)
          ON DELETE CASCADE,
        CONSTRAINT fk_ticket_note_author
          FOREIGN KEY (author_id)
          REFERENCES public."user" (id)
          ON DELETE SET NULL
      )
    `);
    // Hot access pattern: "give me every note on ticket X, oldest
    // first" (interleaved into the message timeline). Compound
    // index covers both the filter and the sort.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ticket_note_ticket_created
        ON public.ticket_note (ticket_id, "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_ticket_note_ticket_created`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.ticket_note`);
  }
}
