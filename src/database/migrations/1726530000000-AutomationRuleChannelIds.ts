import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a per-rule `channel_ids` column on `automation_rule`. Lets an
 * admin scope a rule to specific channel instances (e.g. "WhatsApp
 * 919205241076 only") instead of the coarser `channel_types` filter
 * ("any WhatsApp"). Primary motivation: during the two-WhatsApp-number
 * migration, admins need the OOH / order-confirmation / etc. rules to
 * fire ONLY on the new number so customers on the legacy number don't
 * get double-handled.
 *
 * Semantics (implemented in RuleEvaluator):
 *   - channel_ids is EMPTY → no channel-id-level scoping; the existing
 *     `channel_types` check alone decides. This is the backward-
 *     compatible default — every existing rule starts here.
 *   - channel_ids is NON-EMPTY → rule only fires when the ticket's
 *     channelId is in the list (AND-ed with channel_types).
 */
export class AutomationRuleChannelIds1726530000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "automation_rule"
         ADD COLUMN "channel_ids" text[] NOT NULL DEFAULT '{}'::text[];`,
    );
    // Backfill: for every existing rule that targets WhatsApp at the
    // type level, pre-select EVERY WhatsApp channel UUID. The admin
    // opens the editor, sees both inboxes ticked, and unticks the
    // ones they want to exclude — opt-OUT semantics preserve the
    // pre-migration behaviour (rule fires on all WhatsApp channels)
    // while giving them the control surface to narrow. Portable
    // across workspaces: the subquery reads whatever channels the
    // target DB actually has.
    await queryRunner.query(
      `UPDATE "automation_rule"
          SET "channel_ids" = COALESCE(
                (SELECT array_agg(c.id::text)
                   FROM "channel" c
                  WHERE c.type = 'WHATSAPP'),
                '{}'::text[]
              )
        WHERE 'WHATSAPP' = ANY("channel_types");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "automation_rule" DROP COLUMN "channel_ids";`,
    );
  }
}
