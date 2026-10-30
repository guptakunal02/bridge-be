import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per inbound Return Prime webhook. UNIQUE on `webhook_id`
 * acts as the idempotency guard — see service for how we derive the
 * id from the payload (RP doesn't send a dedicated event-id header).
 */
@Entity({ name: 'return_prime_webhook_event' })
@Index(['received_at'])
export class ReturnPrimeWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true, name: 'webhook_id' })
  webhook_id!: string;

  /** RP topic string (e.g. `request/created`, `request/refunded`). */
  @Column({ type: 'text' })
  topic!: string;

  /** Full JSON payload RP sent. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * Normalized customer phone (digits only, Meta wa_id format) lifted
   * from request.customer.phone (or top-level customer.phone when RP
   * sends unwrapped). Null when the payload lacks a phone. See
   * migration 1726460000000.
   */
  @Column({ type: 'text', nullable: true, name: 'customer_phone' })
  customer_phone!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  received_at!: Date;
}
