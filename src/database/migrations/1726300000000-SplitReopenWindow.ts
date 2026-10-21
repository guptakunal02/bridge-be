import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fork the single `resolved_reopen_window_hours` row into channel-
 * specific rows: `email_resolved_reopen_window_hours` and
 * `whatsapp_resolved_reopen_window_hours`. Each new row inherits the
 * old value (so an admin's 48h setting carries over for both
 * channels), falling back to the hardcoded default (2) when the old
 * row is absent.
 *
 * The legacy row is left in place as a read-only fallback — the
 * service still consults it when a channel-specific row is missing,
 * so a future revert of this migration doesn't lose the admin's
 * historical choice. (It also keeps the FE code path for the old
 * single key compiling against both old and new BEs during the
 * cross-repo roll.)
 */
export class SplitReopenWindow1726300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO public.app_setting (key, value, "updatedAt")
      SELECT 'email_resolved_reopen_window_hours',
             COALESCE(
               (SELECT value FROM public.app_setting
                 WHERE key = 'resolved_reopen_window_hours'),
               '2'
             ),
             NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.app_setting
         WHERE key = 'email_resolved_reopen_window_hours'
      );
    `);
    await queryRunner.query(`
      INSERT INTO public.app_setting (key, value, "updatedAt")
      SELECT 'whatsapp_resolved_reopen_window_hours',
             COALESCE(
               (SELECT value FROM public.app_setting
                 WHERE key = 'resolved_reopen_window_hours'),
               '2'
             ),
             NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.app_setting
         WHERE key = 'whatsapp_resolved_reopen_window_hours'
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM public.app_setting
         WHERE key IN (
           'email_resolved_reopen_window_hours',
           'whatsapp_resolved_reopen_window_hours'
         )`,
    );
  }
}
