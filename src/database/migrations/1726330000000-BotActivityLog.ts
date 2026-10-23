import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `bot_activity_log` — persistent per-session audit trail
 * for the bot runtime (step entered, option matched, handoff fired,
 * session completed / failed, etc.). Replaces reliance on pm2's
 * ephemeral stdout logs for "why did the bot do X on ticket Y"
 * questions and feeds the admin-side session-replay view.
 *
 * `ticket_id` and `session_id` each get their own single-column
 * indexes so lookup by either dimension is a direct scan. `createdAt`
 * gets its own index for the ORDER BY in the replay query (ascending
 * timeline). Indexes are cheap — this is append-only data with no
 * updates and no deletes outside retention.
 */
export class BotActivityLog1726330000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bot_activity_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL,
        ticket_id bigint NOT NULL,
        flow_id uuid NOT NULL,
        step_id uuid NULL,
        event text NOT NULL,
        message text NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_bot_activity_log_ticket_id ON bot_activity_log(ticket_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_bot_activity_log_session_id ON bot_activity_log(session_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_bot_activity_log_created_at ON bot_activity_log("createdAt");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS bot_activity_log;`);
  }
}
