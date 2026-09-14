import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add a nullable `content_html` column to `email_message` so we can
 * store and re-render the sender's original HTML body (buttons,
 * images, styled links). The plain-text `content` column stays as-is
 * for search / previews / legacy rows.
 */
export class AddEmailMessageHtml1725920000000 implements MigrationInterface {
  name = 'AddEmailMessageHtml1725920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.email_message ADD COLUMN IF NOT EXISTS content_html text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.email_message DROP COLUMN IF EXISTS content_html`,
    );
  }
}
