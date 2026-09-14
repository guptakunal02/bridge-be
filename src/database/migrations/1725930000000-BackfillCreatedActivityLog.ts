import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rewrite the free-text `log` on every existing CREATED activity row
 * so it reads "Ticket opened from <sender>" instead of the raw RFC 5322
 * Message-ID we used to embed.
 *
 * The `WHERE log LIKE 'Ticket opened from inbound email %'` filter
 * makes this idempotent: rows already in the new format stay
 * untouched, so re-running or double-applying is a no-op.
 *
 * Correlated to the earliest EmailMessage on each ticket via
 * DISTINCT ON, so the sender we surface is always the person who
 * opened the thread (not a reply, if any subsequent messages exist).
 */
export class BackfillCreatedActivityLog1725930000000 implements MigrationInterface {
  name = 'BackfillCreatedActivityLog1725930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE ticket_activity_log tal
      SET log = 'Ticket opened from ' || first_email.sender
      FROM (
        SELECT DISTINCT ON (ticket_id) ticket_id, sender
        FROM email_message
        WHERE sender IS NOT NULL
        ORDER BY ticket_id, "createdAt" ASC
      ) first_email
      WHERE tal.ticket_id = first_email.ticket_id
        AND tal.event = 'CREATED'
        AND tal.log LIKE 'Ticket opened from inbound email %'
    `);
  }

  public async down(): Promise<void> {
    // Not reversible — the old Message-ID text is discarded.
  }
}
