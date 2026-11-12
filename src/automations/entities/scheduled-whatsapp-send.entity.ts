import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ScheduledSendStatus } from '../../database/enums';

/**
 * One row per queued delayed send_whatsapp_template dispatch. Written
 * by ActionDispatcher when a matched action has delay_minutes > 0,
 * drained by ScheduledWhatsappSendWorker on a 1-min tick.
 *
 * Why snapshot everything (action_config + event_ctx):
 *   * The rule can be edited or deleted during the delay window —
 *     we must send what was true AT MATCH TIME, not what the admin
 *     later changed the template binding to.
 *   * The webhook payload that drove the match can't be re-derived
 *     from current DB state (ticket may have progressed, order status
 *     may have advanced). Storing the full AutomationEventPayload
 *     keeps the handler oblivious to timing.
 *
 * action_config stores the action with delay_minutes zeroed out, so
 * when the worker re-dispatches via ActionDispatcher the inline-send
 * branch runs (no re-queue loop).
 *
 * rule_id is diagnostic only — NOT a FK, so admin-deleting a rule
 * during the wait doesn't orphan or cascade these rows.
 */
@Entity({ name: 'scheduled_whatsapp_send' })
@Index(['status', 'scheduled_at'])
export class ScheduledWhatsappSend {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  rule_id!: string | null;

  /** Snapshot of the Action (send_whatsapp_template) with delay_minutes=0. */
  @Column({ type: 'jsonb' })
  action_config!: Record<string, unknown>;

  /** Snapshot of AutomationEventPayload — ticket + event + payload + rawPayload. */
  @Column({ type: 'jsonb' })
  event_ctx!: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  scheduled_at!: Date;

  @Column({
    type: 'enum',
    enum: ScheduledSendStatus,
    default: ScheduledSendStatus.PENDING,
  })
  status!: ScheduledSendStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
