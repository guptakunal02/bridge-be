import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Relax ticket.assignee from NOT NULL → nullable, and data-cleanup
 * every existing email ticket that was parked to the BOT user by the
 * legacy ingest path.
 *
 * Why: the previous model overloaded the BOT user as both "Groot is
 * actively driving" and "no live members, waiting in queue." That
 * was correct for WhatsApp (Groot really does drive) but wrong for
 * email (Groot has no email runtime — BOT assignment was pure
 * sentinel). The overload caused email tickets to appear under the
 * Bot tab in the inbox and complicated the queue/drain queries.
 *
 * After this migration:
 *   - parked tickets live with assignee IS NULL, read by the UI as
 *     "In queue" (OPEN) or "Unassigned" (other statuses).
 *   - BOT assignee ONLY means "Groot is driving this WhatsApp
 *     ticket" — always paired with an ACTIVE bot_session row.
 *
 * Capacity-backfill + the /my/stats team-queue count are updated in
 * the same release to pull both BOT-held and NULL-assigned OPEN
 * tickets so no ticket falls through the cracks during the roll-
 * over window.
 *
 * The one-time data cleanup flips every EMAIL ticket whose current
 * assignee is BOT AND has no active bot_session (never did — email
 * never spawns one). WhatsApp tickets are left untouched: a BOT
 * WhatsApp ticket with no active session is a known transitional
 * state the WhatsApp handoff path still relies on and we'll refactor
 * that separately.
 */
export class TicketAssigneeNullable1726490000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ticket ALTER COLUMN assignee DROP NOT NULL;
    `);

    // One-time cleanup: flip historically-BOT-parked EMAIL tickets to
    // NULL so the new UI + queries read them consistently. Scoped by
    // channel.type so WhatsApp parking (which does use BOT as the
    // Groot driver) stays intact.
    await queryRunner.query(`
      UPDATE ticket t
         SET assignee = NULL
        FROM channel ch, public."user" u
       WHERE ch.id = t.channel_id
         AND ch.type = 'EMAIL'
         AND u.id = t.assignee
         AND u.role = 'BOT';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No data rollback — restoring the NOT NULL constraint would
    // require re-populating every nullified assignee with a plausible
    // BOT id lookup and risks data loss on tickets that were created
    // genuinely unassigned post-migration. If a rollback is ever
    // needed, run the equivalent cleanup manually first.
    await queryRunner.query(`
      ALTER TABLE ticket ALTER COLUMN assignee SET NOT NULL;
    `);
  }
}
