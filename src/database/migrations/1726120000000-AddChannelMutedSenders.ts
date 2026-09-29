import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-channel mute list. Each entry is a raw string that the ingest
 * pipeline matches against the inbound sender before deciding
 * whether to create a ticket:
 *
 *   * EMAIL channels — pattern is either a full address (contains @)
 *     matched case-insensitively, or a bare domain matched as a
 *     domain-suffix of the sender's address (e.g. `judge.me` mutes
 *     `support@judge.me` and `noreply@judge.me` alike).
 *   * WHATSAPP channels (future) — E.164 phone match.
 *   * INSTAGRAM channels (future) — lowercase handle match.
 *
 * text[] rather than a join table because the list is small
 * (a few dozen entries per inbox, tops) and we always read the
 * whole thing on every inbound message. Storing it inline keeps the
 * hot path a single SELECT with no join, and the FE editor becomes
 * "replace the array" instead of "diff and PATCH rows."
 */
export class AddChannelMutedSenders1726120000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.channel
        ADD COLUMN IF NOT EXISTS muted_senders text[] NOT NULL DEFAULT '{}'::text[]
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.channel DROP COLUMN IF EXISTS muted_senders
    `);
  }
}
