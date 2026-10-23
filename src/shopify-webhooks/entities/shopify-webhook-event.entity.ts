import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per inbound Shopify webhook. The UNIQUE on `webhook_id`
 * is the idempotency check: the controller tries to INSERT first;
 * a duplicate (same webhook_id already present) means Shopify
 * retried, so we short-circuit to 200 without re-emitting the
 * automation event. See the migration for retention notes.
 */
@Entity({ name: 'shopify_webhook_event' })
@Index(['shop_domain', 'received_at'])
export class ShopifyWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `X-Shopify-Webhook-Id` from the request header. */
  @Column({ type: 'text', unique: true, name: 'webhook_id' })
  webhook_id!: string;

  /** `X-Shopify-Topic` (e.g. `orders/create`). */
  @Column({ type: 'text' })
  topic!: string;

  /** `X-Shopify-Shop-Domain` (e.g. `surma.myshopify.com`). */
  @Column({ type: 'text', name: 'shop_domain' })
  shop_domain!: string;

  /** The parsed JSON payload Shopify sent. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  received_at!: Date;
}
