import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the last UID the IMAP worker successfully drained to —
 * one column per folder (INBOX + Sent Mail). Lets the worker's
 * start() resume where the previous process left off instead of
 * jumping to the folder's current uidNext-1 (which silently buries
 * every message that arrived while the worker was down).
 *
 * Historical bug (ticket #1132, 2026-10-08): on every pm2
 * restart the Sent worker set lastUid = uidNext - 1, treating
 * every pre-existing Sent message as "already processed." Any
 * Gmail-side agent reply sent during a restart window — or
 * between a reboot and the first post-restart EXISTS event —
 * was permanently invisible to Bridge. The thread's full
 * context went missing from the UI.
 *
 * NULL default is intentional: on first boot after this migration,
 * both columns are null and the worker falls back to the
 * `uidNext - 1` behaviour (same as before). Once the worker
 * writes a value, every subsequent boot resumes from it.
 *
 * Idempotency on external_message_id already covers the race
 * where a drain cycle persists the message but crashes before
 * updating the UID — the re-process on next boot is a no-op.
 */
export class ChannelLastProcessedUids1726190000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.channel
        ADD COLUMN IF NOT EXISTS last_processed_inbox_uid integer NULL,
        ADD COLUMN IF NOT EXISTS last_processed_sent_uid  integer NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.channel
        DROP COLUMN IF EXISTS last_processed_inbox_uid,
        DROP COLUMN IF EXISTS last_processed_sent_uid
    `);
  }
}
