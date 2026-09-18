import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `AGENT_REPLIED` to the ticket-activity enum so outbound
 * replies get their own event class in the ticket history (rather
 * than piggybacking on NOTES_ADDED). Postgres allows enum-value
 * additions without a table rewrite; the operation is fast and
 * online-safe.
 */
export class AddAgentRepliedActivity1726060000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE public.ticket_activity_log_event_enum ADD VALUE IF NOT EXISTS 'AGENT_REPLIED'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres doesn't support removing enum values without recreating
    // the type and rewriting every column that references it. Since
    // AGENT_REPLIED is additive and consumers ignore unknown values,
    // the safe rollback is a no-op — a subsequent up() is idempotent.
  }
}
