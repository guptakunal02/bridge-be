import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One row per inbound Lens-forwarded delivery-exception event. Lens
 * (surma-ops) classifies Clickpost scans and forwards NDR / NPR events
 * to Bridge in addition to its existing LimeChat path — this table is
 * the dedup + audit log on the Bridge side.
 *
 * UNIQUE on `event_id` is the idempotency guard. Lens reuses the same
 * event_id as its LimeChat idempotency key, so retries from either
 * side land on the same row (see Lens's handoff doc for the shape:
 * `auto:ndr_v2:<orderRowId>`, `ndr:<order|return>:<orderRowId>`,
 * `npr_v3:<subject_type>:<subject_id>:attempt_<N>`, etc).
 */
@Entity({ name: 'lens_webhook_event' })
@Index(['received_at'])
@Index(['topic', 'received_at'])
export class LensWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lens's stable idempotency key — doubles as our dedup column. */
  @Column({ type: 'text', unique: true, name: 'event_id' })
  event_id!: string;

  /** 'ndr' or 'npr'. Future topics land here too without schema change. */
  @Column({ type: 'text' })
  topic!: string;

  /** Full raw payload as Lens forwarded it. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  received_at!: Date;
}
