import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 1 (member presence / routing) DB shape:
 *   - Expand user_status_enum with MEETING, BREAK, EMERGENCY.
 *     AWAY is retired but left declared so any historical row using
 *     it doesn't break; we normalise those to OFFLINE.
 *   - Add User.status_changed_at (NOT NULL, default NOW). Backfilled
 *     to createdAt for existing rows so admins see a real timestamp
 *     rather than the migration moment.
 *   - Add User.last_assigned_at (nullable). Cursor for the
 *     round-robin auto-assigner.
 *
 * Fully idempotent: uses ADD VALUE IF NOT EXISTS on the enum and
 * ADD COLUMN IF NOT EXISTS on the columns.
 */
export class UserPresenceColumns1725940000000 implements MigrationInterface {
  name = 'UserPresenceColumns1725940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum expansion — must run outside a transaction on some Postgres
    // versions when adding to a used enum, but Postgres 12+ handles
    // this inside a txn. queryRunner default is txn-per-migration.
    await queryRunner.query(
      `ALTER TYPE public.user_status_enum ADD VALUE IF NOT EXISTS 'MEETING'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.user_status_enum ADD VALUE IF NOT EXISTS 'BREAK'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.user_status_enum ADD VALUE IF NOT EXISTS 'EMERGENCY'`,
    );

    // Normalise any AWAY holdovers to OFFLINE.
    await queryRunner.query(
      `UPDATE public."user" SET status = 'OFFLINE' WHERE status = 'AWAY'`,
    );

    await queryRunner.query(
      `ALTER TABLE public."user"
         ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT NOW()`,
    );
    await queryRunner.query(
      `UPDATE public."user"
         SET status_changed_at = "createdAt"
         WHERE status_changed_at = "updatedAt" AND status_changed_at > "createdAt"`,
    );

    await queryRunner.query(
      `ALTER TABLE public."user"
         ADD COLUMN IF NOT EXISTS last_assigned_at timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum values can't be dropped in Postgres without dropping the
    // type and recreating it, which cascades to every column using it.
    // For MVP we accept the enum entries as forward-only.
    await queryRunner.query(
      `ALTER TABLE public."user" DROP COLUMN IF EXISTS last_assigned_at`,
    );
    await queryRunner.query(
      `ALTER TABLE public."user" DROP COLUMN IF EXISTS status_changed_at`,
    );
  }
}
