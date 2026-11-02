import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Captures Meta's `context.id` on inbound WhatsApp messages — the wamid
 * of the message the customer swiped-to-reply on. Lets the inbox UI
 * render a WhatsApp-style quote block above the reply bubble so an
 * agent sees the conversation thread exactly as the customer does.
 *
 * We already store the full inbound message under `raw_payload` so the
 * data has always been there — this column just surfaces the id to a
 * first-class, indexable position for cheap lookups at ticket render
 * time. Partial index on NOT NULL since the vast majority of messages
 * don't quote anything.
 */
export class WhatsappMessageRepliedTo1726470000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE whatsapp_message
        ADD COLUMN replied_to_external_message_id text NULL;
      CREATE INDEX idx_whatsapp_message_replied_to_external_message_id
        ON whatsapp_message (replied_to_external_message_id)
        WHERE replied_to_external_message_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_whatsapp_message_replied_to_external_message_id;
      ALTER TABLE whatsapp_message DROP COLUMN replied_to_external_message_id;
    `);
  }
}
