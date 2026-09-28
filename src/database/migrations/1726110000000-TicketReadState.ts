import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user, per-ticket read state. `last_read_at` gets bumped every
 * time the user opens the ticket; the list endpoint uses it to count
 * inbound messages that arrived after that timestamp — that's the
 * unread badge on the sidebar navigation rail.
 *
 * PK on (user_id, ticket_id) keeps upserts fast and guarantees at
 * most one row per pair. ON DELETE CASCADE on both sides so the
 * table can't drift if a user is removed or a ticket is deleted.
 *
 * Deliberately no per-message read tracking. Row-per-message would
 * balloon fast and doesn't give agents anything useful — "unread
 * count since last time I looked" is the mental model that
 * matches Gmail / WhatsApp / LimeChat.
 */
export class TicketReadState1726110000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.ticket_read_state (
        user_id       uuid        NOT NULL,
        ticket_id     bigint      NOT NULL,
        last_read_at  timestamptz NOT NULL DEFAULT now(),
        "createdAt"   timestamptz NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ticket_read_state_pkey PRIMARY KEY (user_id, ticket_id),
        CONSTRAINT fk_ticket_read_state_user
          FOREIGN KEY (user_id)
          REFERENCES public.user (id)
          ON DELETE CASCADE,
        CONSTRAINT fk_ticket_read_state_ticket
          FOREIGN KEY (ticket_id)
          REFERENCES public.ticket (id)
          ON DELETE CASCADE
      )
    `);
    // "Which tickets does this user have unread activity on" is the
    // hot access pattern; user_id-leading index keeps it O(log n).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ticket_read_state_user_id
        ON public.ticket_read_state (user_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_ticket_read_state_user_id`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS public.ticket_read_state`,
    );
  }
}
