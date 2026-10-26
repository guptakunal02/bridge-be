import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 of the Marketing Messages tooling: durable, phone-keyed
 * contact book + named segments + the CSV upload job surface.
 *
 * Deliberately no FKs between Customer and the inbox/ticket world
 * — phone-number-strings on Ticket already carry that association;
 * duplicating it here would force the ticket pipeline to care
 * about Customer existence (it shouldn't).
 *
 * Opt-out behaviour (STOP / UNSUBSCRIBE) is NOT a dedicated table
 * — the admin configures it as a regular automation rule
 * (trigger: message.received, action: opt_out_customer) in the
 * existing automations UI. The `marketing_opted_out` flag on
 * Customer is the flag that action flips.
 */
export class OutreachInitial1726370000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE customer_source_enum AS ENUM (
        'CSV', 'WHATSAPP_INBOUND', 'SHOPIFY_WEBHOOK'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE customer_upload_status_enum AS ENUM (
        'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
      );
    `);

    await queryRunner.query(`
      CREATE TABLE customer (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        phone text NOT NULL,
        name text NULL,
        email text NULL,
        source customer_source_enum NOT NULL DEFAULT 'CSV',
        shopify_customer_id text NULL,
        marketing_opted_out boolean NOT NULL DEFAULT false,
        opted_out_at timestamptz NULL,
        opted_out_keyword text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX idx_customer_phone ON customer(phone);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_customer_opted_out ON customer(marketing_opted_out) WHERE marketing_opted_out = true;`,
    );

    await queryRunner.query(`
      CREATE TABLE segment (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        description text NULL,
        created_by uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE segment_customer (
        segment_id uuid NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
        customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
        added_at timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (segment_id, customer_id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_segment_customer_customer ON segment_customer(customer_id);`,
    );

    await queryRunner.query(`
      CREATE TABLE customer_upload (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        segment_id uuid NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
        uploaded_by uuid NOT NULL,
        file_name text NOT NULL,
        file_size bigint NOT NULL,
        status customer_upload_status_enum NOT NULL DEFAULT 'PENDING',
        total_rows integer NOT NULL DEFAULT 0,
        processed_rows integer NOT NULL DEFAULT 0,
        succeeded_rows integer NOT NULL DEFAULT 0,
        skipped_rows integer NOT NULL DEFAULT 0,
        rejected_rows integer NOT NULL DEFAULT 0,
        rejections jsonb NOT NULL DEFAULT '[]'::jsonb,
        error text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        completed_at timestamptz NULL
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_customer_upload_segment_created
       ON customer_upload(segment_id, "createdAt" DESC);`,
    );

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS customer_upload;`);
    await queryRunner.query(`DROP TABLE IF EXISTS segment_customer;`);
    await queryRunner.query(`DROP TABLE IF EXISTS segment;`);
    await queryRunner.query(`DROP TABLE IF EXISTS customer;`);
    await queryRunner.query(`DROP TYPE IF EXISTS customer_upload_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS customer_source_enum;`);
  }
}
