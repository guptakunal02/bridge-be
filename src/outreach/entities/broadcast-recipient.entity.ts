import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BroadcastRecipientStatus } from '../../database/enums';

/**
 * One row per (broadcast, customer) target. Snapshotted at broadcast
 * creation time so that:
 *   * subsequent CSV re-uploads to the segment don't change this
 *     broadcast's audience,
 *   * subsequent STOP → opted_out doesn't retroactively flip rows
 *     already sent (we filtered at snapshot time; a STOP that
 *     arrives mid-run DOES prevent further attempts for that row
 *     — the worker re-checks before each send).
 *
 * `variables_resolved` carries the per-recipient template fill
 * values resolved at snapshot time from Customer fields on the
 * segment. Keeping them here means the worker never queries
 * Customer again at send time — it reads this row and fires.
 * Resolving at snapshot (not at send) also means the audience is
 * frozen: a late name correction in CSV re-upload won't retroactively
 * change a broadcast that was already composed.
 */
@Entity({ name: 'broadcast_recipient' })
@Index(['broadcast_id', 'status'])
export class BroadcastRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  broadcast_id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  /** Full combined phone (digits-only). Snapshot from Customer.phone. */
  @Column({ type: 'text' })
  phone!: string;

  @Column({
    type: 'enum',
    enum: BroadcastRecipientStatus,
    default: BroadcastRecipientStatus.PENDING,
  })
  status!: BroadcastRecipientStatus;

  /**
   * Pre-resolved {{var}} values for this row's template fill —
   * ordered by the template's variableMapping index (position 1,
   * position 2, ...). Null entries mean the segment didn't have
   * that field for this customer; sender uses the template's
   * configured fallback.
   */
  @Column({ type: 'jsonb', name: 'variables_resolved' })
  variables_resolved!: Array<string | null>;

  /** Meta's wam_id, populated after a successful send. */
  @Column({ type: 'text', nullable: true })
  wam_id!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'sent_at' })
  sent_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  delivered_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'read_at' })
  read_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
