import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketing Phase 1 refactor — swap synonym-matching for explicit
 * admin-chosen column mapping on CSV upload, and lift Customer
 * from a flat "name" field to split first_name + last_name +
 * country_code + phone_number.
 *
 * Why: synonym matching on CSV headers was clever but fragile —
 * admins uploaded Shopify exports with `firstname` / `lastname` and
 * got mysterious 100%-rejected results because the logic was
 * inferring the wrong column OR couldn't tell country_code apart.
 * The new flow asks the admin to explicitly pick which CSV column
 * holds each of the 5 Customer fields; mandatory on country_code +
 * phone_number, optional on the other three.
 *
 * Templates targeted at MARKETING broadcasts can only reference
 * `first_name`, `last_name`, `email` — the three fields a segment
 * might carry. The restriction is enforced at template-create time
 * (service layer), not at the schema. UTILITY / AUTHENTICATION
 * templates keep the full ticket-based variable registry.
 *
 * Backfill:
 *   * first_name / last_name — split `name` on first space;
 *     single-token names go to first_name only.
 *   * country_code / phone_number — infer from `phone`: 12-digit
 *     "91…" → ("91", last 10); 10-digit → ("91", phone); other →
 *     country_code NULL. Keeps STOP-created rows (which came in via
 *     webhook as digits-only) working; broadcast-time code tolerates
 *     NULL country_code.
 *
 * `status: PENDING` is reused for the new "STAGED" meaning (file
 * uploaded, mapping not yet chosen) — avoids an enum migration.
 * The `mapping jsonb` column being NULL is the actual "staged"
 * signal; non-NULL means the admin chose columns and the worker is
 * either running or finished.
 */
export class OutreachMappingRefactor1726400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE customer
        ADD COLUMN country_code text NULL,
        ADD COLUMN phone_number text NULL,
        ADD COLUMN first_name text NULL,
        ADD COLUMN last_name text NULL;
    `);

    await queryRunner.query(`
      UPDATE customer SET
        first_name = CASE
          WHEN name IS NULL THEN NULL
          WHEN position(' ' in trim(name)) = 0 THEN trim(name)
          ELSE split_part(trim(name), ' ', 1)
        END,
        last_name = CASE
          WHEN name IS NULL THEN NULL
          WHEN position(' ' in trim(name)) = 0 THEN NULL
          ELSE substring(trim(name) from position(' ' in trim(name)) + 1)
        END;
    `);

    await queryRunner.query(`
      UPDATE customer SET
        country_code = CASE
          WHEN length(phone) = 12 AND phone LIKE '91%' THEN '91'
          WHEN length(phone) = 10 THEN '91'
          ELSE NULL
        END,
        phone_number = CASE
          WHEN length(phone) = 12 AND phone LIKE '91%' THEN substring(phone from 3)
          WHEN length(phone) = 10 THEN phone
          ELSE phone
        END;
    `);

    await queryRunner.query(`ALTER TABLE customer DROP COLUMN name;`);

    await queryRunner.query(`
      ALTER TABLE segment
        ADD COLUMN mapped_fields text[] NOT NULL DEFAULT '{}'::text[];
    `);

    await queryRunner.query(`
      ALTER TABLE customer_upload ADD COLUMN mapping jsonb NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE customer_upload DROP COLUMN mapping;
    `);
    await queryRunner.query(`
      ALTER TABLE segment DROP COLUMN mapped_fields;
    `);
    await queryRunner.query(`
      ALTER TABLE customer ADD COLUMN name text NULL;
    `);
    // Lossy — rejoin first_name + last_name on down.
    await queryRunner.query(`
      UPDATE customer SET name =
        CASE
          WHEN first_name IS NULL AND last_name IS NULL THEN NULL
          WHEN last_name IS NULL THEN first_name
          WHEN first_name IS NULL THEN last_name
          ELSE first_name || ' ' || last_name
        END;
    `);
    await queryRunner.query(`
      ALTER TABLE customer
        DROP COLUMN last_name,
        DROP COLUMN first_name,
        DROP COLUMN phone_number,
        DROP COLUMN country_code;
    `);
  }
}
