import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per inbound Rewind webhook. Same pattern as the clickpost /
 * shopify / return-prime audit tables: UNIQUE on `webhook_id` is the
 * idempotency guard against retry storms, and the row drives the
 * Integrations page's "last event received" display + topic stats.
 *
 * Rewind's shared body shape has no stable event id; the service
 * synthesizes one (sha256 of the body) so byte-identical retries
 * dedup at INSERT time.
 */
@Entity({ name: 'rewind_webhook_event' })
@Index(['received_at'])
@Index(['event_type', 'received_at'])
export class RewindWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true, name: 'webhook_id' })
  webhook_id!: string;

  /**
   * The `event` field as the Rewind caller sent it (e.g.
   * "rewind.points_earned", "rewind.subscription_cancelled"). Admin
   * rules filter on this via the `event.eventType` predicate so admins
   * can build "When Rewind reports X" without a BE change per new
   * loyalty event — loyalty taxonomies evolve faster than our deploy
   * cadence.
   */
  @Column({ type: 'text', name: 'event_type' })
  event_type!: string;

  /**
   * Full raw body as POSTed. Includes `event`, `customerPhone`,
   * `channelId`, `variables?`, `rawPayload?` — we persist the whole
   * body (not just `rawPayload`) so admin forensics can reconstruct
   * exactly what the caller sent.
   */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * Normalized customer phone (digits-only Meta wa_id format) lifted
   * from the DTO at ingest time. Nullable so backend-only Rewind
   * events that omit a customer (e.g. tier recalculations, if Rewind
   * ever sends them here) still get audited.
   */
  @Column({ type: 'text', nullable: true, name: 'customer_phone' })
  customer_phone!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  received_at!: Date;
}
