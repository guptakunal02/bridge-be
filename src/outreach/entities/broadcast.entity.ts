import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BroadcastStatus } from '../../database/enums';

/**
 * A single marketing broadcast: a point-in-time snapshot of
 * (segment × template) that will be delivered to the segment's
 * non-opted-out members. The admin names + schedules it, we fan it
 * out through the sender, Meta tells us per-recipient status via
 * webhook (future).
 *
 * Segment-template coupling is enforced at creation time:
 * `template.referenced_variables ⊆ segment.mapped_fields`. If a
 * template references `{{first_name}}` but the segment didn't map
 * first_name at upload, creation rejects. This is the whole
 * reason the segment schema exists.
 *
 * Stats columns (`sent_count`, etc.) are maintained by the worker
 * + webhook paths; they're persistent aggregates of
 * BroadcastRecipient rows so the detail page doesn't recompute
 * on every poll. Reconciliation query at the end of a run keeps
 * them honest.
 */
@Entity({ name: 'broadcast' })
@Index(['status'])
@Index(['segment_id'])
export class Broadcast {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'uuid' })
  segment_id!: string;

  @Column({ type: 'uuid' })
  template_id!: string;

  @Column({ type: 'uuid', nullable: true })
  channel_id!: string | null;

  @Column({ type: 'enum', enum: BroadcastStatus, default: BroadcastStatus.DRAFT })
  status!: BroadcastStatus;

  /**
   * When admin wants the send to start. NULL for "start now" (DRAFT
   * → SENDING on explicit Start click). V1 doesn't yet have a cron
   * that watches this field — it's reserved for Phase-3-and-a-half.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'scheduled_for' })
  scheduled_for!: Date | null;

  /**
   * Per-broadcast retry policy. `max_tries` is the ceiling on
   * send-attempts for one recipient; `retry_window_minutes` is the
   * window within which those attempts are made (if the window
   * elapses before the quota is used up, the row goes FAILED).
   * V1 defaults: 3 tries over 60 minutes — tuned for marketing where
   * a stuck message is better dropped than retried days later.
   */
  @Column({ type: 'integer', default: 3, name: 'max_tries' })
  max_tries!: number;

  @Column({ type: 'integer', default: 60, name: 'retry_window_minutes' })
  retry_window_minutes!: number;

  /**
   * Optional send-time override of the template's header image URL
   * — Phase 2a stored the "sample" image on the template, but a
   * campaign can swap it (same template, different artwork). NULL
   * uses the template's default.
   */
  @Column({ type: 'text', nullable: true, name: 'header_image_url_override' })
  header_image_url_override!: string | null;

  /**
   * Stats aggregates — updated per-batch by the worker so the
   * detail page can poll a single row instead of GROUP BY'ing the
   * recipients table. Reconciled at the end of a run.
   */
  @Column({ type: 'integer', default: 0, name: 'total_recipients' })
  total_recipients!: number;

  @Column({ type: 'integer', default: 0, name: 'sent_count' })
  sent_count!: number;

  @Column({ type: 'integer', default: 0, name: 'delivered_count' })
  delivered_count!: number;

  @Column({ type: 'integer', default: 0, name: 'read_count' })
  read_count!: number;

  @Column({ type: 'integer', default: 0, name: 'failed_count' })
  failed_count!: number;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;
}
