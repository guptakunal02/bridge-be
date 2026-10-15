import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A read-only view that lets inbox-list / search / sort code treat
 * every ticket's messages uniformly, regardless of which physical
 * table the row lives in.
 *
 * Why a view and not a unified table: email_message / whatsapp_message
 * (and future Instagram / SMS) each carry channel-specific columns
 * (HTML body, reply-to headers, wa_id, template context, media
 * refs...) that don't flatten cleanly into one wide table. Keeping
 * them physically separate preserves channel-specific invariants and
 * avoids a 100K-row backfill, while the view gives list/search code
 * a single, narrow surface. Adding Instagram = one more UNION ALL
 * arm in a future migration; zero service-code churn.
 *
 * Shape (narrow on purpose — only the columns list-path code needs):
 *   ticket_id   bigint     — join key
 *   direction   enum       — SENT / RECEIVED (reused from email)
 *   sender      text       — channel-native identifier
 *                             email  → the sender address
 *                             whatsapp → wa_id (digits, no "+")
 *                             presentation formatting happens in the
 *                             DTO mapper, not here
 *   subject     text       — null for channels without a subject line
 *   content     text       — plain-text body (nullable for media)
 *   "createdAt" timestamptz
 *
 * email_message rows with "deletedAt" set are excluded; whatsapp has
 * no soft-delete column yet (added when we need it, same model).
 */
export class MessageView1726210000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE VIEW public.message AS
        SELECT
          ticket_id,
          type       AS direction,
          sender,
          subject,
          content,
          "createdAt"
        FROM public.email_message
        WHERE "deletedAt" IS NULL
        UNION ALL
        SELECT
          ticket_id,
          type       AS direction,
          sender,
          NULL::text AS subject,
          content,
          "createdAt"
        FROM public.whatsapp_message;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS public.message;`);
  }
}
