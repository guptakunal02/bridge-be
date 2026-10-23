import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per inbound Clickpost tracking webhook. UNIQUE on
 * `webhook_id` is the idempotency guard — derived from
 * (waybill, clickpost_status_code, timestamp) at receive time.
 */
@Entity({ name: 'clickpost_webhook_event' })
@Index(['received_at'])
export class ClickpostWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true, name: 'webhook_id' })
  webhook_id!: string;

  /** Carrier status string (e.g. `OFD`, `Delivered`). */
  @Column({ type: 'text' })
  status!: string;

  /** AWB / tracking number — null if Clickpost sent a payload without it. */
  @Column({ type: 'text', nullable: true })
  waybill!: string | null;

  /** Shopify order id lifted from `additional.order_id`. Null when absent. */
  @Column({ type: 'text', nullable: true, name: 'order_id' })
  order_id!: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  received_at!: Date;
}
