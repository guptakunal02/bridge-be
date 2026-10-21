import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `kind` to email_template (REPLY vs OUTREACH) + makes subject
 * nullable since REPLY templates don't carry one (they inherit the
 * thread's "Re: <original>" subject at send time).
 *
 * Backfill: every existing row flips to OUTREACH (safest default
 * — all current templates were authored under the "subject +
 * body" model that matches outreach semantics). Admins can convert
 * individual rows to REPLY from the detail page if that's what
 * they intended.
 */
export class EmailTemplateKind1726280000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "email_template_kind_enum" AS ENUM ('REPLY', 'OUTREACH');
    `);
    await queryRunner.query(`
      ALTER TABLE "email_template"
        ADD COLUMN "kind" "email_template_kind_enum" NOT NULL DEFAULT 'OUTREACH',
        ALTER COLUMN "subject" DROP NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // On revert: force any null subjects to a placeholder before
    // re-enforcing NOT NULL (we don't know what the original intended
    // subject was for a REPLY row, but a non-null placeholder is
    // required to re-apply the constraint).
    await queryRunner.query(`
      UPDATE "email_template"
         SET "subject" = '(reply)'
       WHERE "subject" IS NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "email_template"
        DROP COLUMN IF EXISTS "kind",
        ALTER COLUMN "subject" SET NOT NULL;
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "email_template_kind_enum";`,
    );
  }
}
