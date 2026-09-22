import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attachments arrive with inbound emails via the IMAP loop. We
 * upload bytes to S3 (public-read bucket, direct URLs) and store
 * the metadata + URL here — one row per attachment, joined back
 * to the parent email_message via message_id.
 *
 * Kept as a separate table (rather than a jsonb column on
 * email_message) so a single message with 20 attachments doesn't
 * bloat the message row, and so each attachment can be indexed
 * / deleted / audited on its own.
 */
export class EmailMessageAttachments1726080000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.email_message_attachment (
        id            uuid          NOT NULL DEFAULT uuid_generate_v4(),
        message_id    uuid          NOT NULL,
        filename      text          NOT NULL,
        content_type  text          NOT NULL,
        size_bytes    bigint        NOT NULL,
        storage_key   text          NOT NULL,
        storage_url   text          NOT NULL,
        "createdAt"   timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT email_message_attachment_pkey PRIMARY KEY (id),
        CONSTRAINT fk_email_message_attachment_message
          FOREIGN KEY (message_id)
          REFERENCES public.email_message (id)
          ON DELETE CASCADE
      )
    `);

    // Every read is scoped to a single message, so the FK column is
    // the natural anchor.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_email_message_attachment_message
        ON public.email_message_attachment (message_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS public.email_message_attachment`,
    );
  }
}
