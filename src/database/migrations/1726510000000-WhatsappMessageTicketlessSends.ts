import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make whatsapp_message.ticket_id nullable + add recipient_wa_id, so
 * automation-fired ticketless outbound sends (Shopify / Clickpost /
 * Return Prime webhook rules that don't match to an open ticket) can
 * finally land as rows in the same table every other message lives
 * in. Previously these sends were fire-and-forget — the handler
 * called Meta then returned, leaving no trace beyond a pm2 log line.
 *
 * With this schema:
 *   * inbound  →  ticket_id SET,   sender = customer wa_id, recipient_wa_id NULL
 *   * outbound ticket-path → ticket_id SET, sender = business pnid,
 *     recipient_wa_id NULL (join to customer via ticket.thread_key).
 *   * outbound webhook-path → ticket_id NULL, sender = business pnid,
 *     recipient_wa_id = customer wa_id digits.
 *
 * The recipient_wa_id index lets /whatsapp/history/by-phone surface
 * these ticketless sends cheaply. We don't backfill historical sends —
 * those were never persisted at all and can't be recovered (Meta has
 * no retrieval API).
 */
export class WhatsappMessageTicketlessSends1726510000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "whatsapp_message" ALTER COLUMN "ticket_id" DROP NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "whatsapp_message" ADD COLUMN "recipient_wa_id" text NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_whatsapp_message_recipient_at"
        ON "whatsapp_message" ("recipient_wa_id", "createdAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_whatsapp_message_recipient_at";`,
    );
    await queryRunner.query(
      `ALTER TABLE "whatsapp_message" DROP COLUMN IF EXISTS "recipient_wa_id";`,
    );
    // Not restoring NOT NULL — any ticketless rows written between
    // up() and a hypothetical rollback would violate the constraint.
    // Admin must manually delete ticket_id-null rows first if truly
    // needed.
  }
}
