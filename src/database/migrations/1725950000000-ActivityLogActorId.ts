import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add a nullable `actor_id` to `ticket_activity_log` so we can filter
 * "resolved by X today" without doing fragile LIKE matches on the
 * free-text `log` column. Backed by an index on
 * (actor_id, event, "createdAt") because that's the shape of the
 * throughput queries.
 *
 * Legacy rows keep actor_id = NULL (which is correct — for CREATED /
 * ASSIGNED_TO_BOT logs, the system was the actor).
 */
export class ActivityLogActorId1725950000000 implements MigrationInterface {
  name = 'ActivityLogActorId1725950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE public.ticket_activity_log ADD COLUMN IF NOT EXISTS actor_id uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ticket_activity_log_actor_event_createdAt_idx
       ON public.ticket_activity_log (actor_id, event, "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.ticket_activity_log_actor_event_createdAt_idx`,
    );
    await queryRunner.query(
      `ALTER TABLE public.ticket_activity_log DROP COLUMN IF EXISTS actor_id`,
    );
  }
}
