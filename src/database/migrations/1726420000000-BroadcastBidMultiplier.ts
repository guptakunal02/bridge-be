import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 bidding fix: per-broadcast `per_message_bid_multiplier`
 * so one max-price template can be reused across campaigns with a
 * different effective bid per campaign (0.5× for a budget-conscious
 * cohort, 1.5× for a high-value cohort, etc.). Default (NULL / 1.0)
 * passes the template's bid through unchanged.
 *
 * Why this and not a direct bid_amount override: Meta's Marketing
 * Messages API design puts the max-price on the TEMPLATE at create
 * time (`optimization_spec.bid_amount`) and lets us scale it per
 * send with `bid_spec.per_message_bid_multiplier`. The multiplier is
 * the only broadcast-level knob they expose.
 */
export class BroadcastBidMultiplier1726420000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broadcast
        ADD COLUMN per_message_bid_multiplier numeric(5,2) NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broadcast DROP COLUMN per_message_bid_multiplier;
    `);
  }
}
