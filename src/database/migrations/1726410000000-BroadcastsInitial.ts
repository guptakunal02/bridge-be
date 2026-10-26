import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 — marketing broadcast tables. One Broadcast row owns the
 * send; many BroadcastRecipient rows carry per-customer snapshotted
 * fill values + status. Status is tracked on both sides: a single
 * Broadcast.status column plus denormalised per-status counters so
 * the detail page can poll a single row, and a BroadcastRecipient
 * row per target with its own status.
 */
export class BroadcastsInitial1726410000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE broadcast_status_enum AS ENUM (
        'DRAFT', 'SCHEDULED', 'SENDING', 'COMPLETED', 'CANCELLED', 'FAILED'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE broadcast_recipient_status_enum AS ENUM (
        'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'
      );
    `);

    await queryRunner.query(`
      CREATE TABLE broadcast (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        segment_id uuid NOT NULL REFERENCES segment(id) ON DELETE RESTRICT,
        template_id uuid NOT NULL REFERENCES whatsapp_template(id) ON DELETE RESTRICT,
        channel_id uuid NULL REFERENCES channel(id) ON DELETE SET NULL,
        status broadcast_status_enum NOT NULL DEFAULT 'DRAFT',
        scheduled_for timestamptz NULL,
        max_tries integer NOT NULL DEFAULT 3,
        retry_window_minutes integer NOT NULL DEFAULT 60,
        header_image_url_override text NULL,
        total_recipients integer NOT NULL DEFAULT 0,
        sent_count integer NOT NULL DEFAULT 0,
        delivered_count integer NOT NULL DEFAULT 0,
        read_count integer NOT NULL DEFAULT 0,
        failed_count integer NOT NULL DEFAULT 0,
        created_by uuid NOT NULL,
        error text NULL,
        started_at timestamptz NULL,
        completed_at timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_broadcast_status ON broadcast(status);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_broadcast_segment ON broadcast(segment_id);`,
    );

    await queryRunner.query(`
      CREATE TABLE broadcast_recipient (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        broadcast_id uuid NOT NULL REFERENCES broadcast(id) ON DELETE CASCADE,
        customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE RESTRICT,
        phone text NOT NULL,
        status broadcast_recipient_status_enum NOT NULL DEFAULT 'PENDING',
        variables_resolved jsonb NOT NULL DEFAULT '[]'::jsonb,
        wam_id text NULL,
        attempts integer NOT NULL DEFAULT 0,
        last_error text NULL,
        sent_at timestamptz NULL,
        delivered_at timestamptz NULL,
        read_at timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_broadcast_recipient_broadcast_status
       ON broadcast_recipient(broadcast_id, status);`,
    );
    // The worker queries PENDING rows for a given broadcast ordered
    // by id — the partial index keeps the hot path small as rows
    // settle out of PENDING.
    await queryRunner.query(
      `CREATE INDEX idx_broadcast_recipient_pending
       ON broadcast_recipient(broadcast_id, id)
       WHERE status = 'PENDING';`,
    );
    // Fast webhook lookup — Meta's delivery/read callbacks arrive
    // keyed on the wam_id; we need to find the recipient row to
    // flip its status.
    await queryRunner.query(
      `CREATE INDEX idx_broadcast_recipient_wam
       ON broadcast_recipient(wam_id)
       WHERE wam_id IS NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS broadcast_recipient;`);
    await queryRunner.query(`DROP TABLE IF EXISTS broadcast;`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS broadcast_recipient_status_enum;`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS broadcast_status_enum;`);
  }
}
