import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Audit trail for a bot session's state transitions. One row per
 * meaningful event: step entered, step exited, option matched,
 * handoff fired, session completed / failed. Powered the ability to
 * debug "why did the bot do X on ticket Y" after the fact —
 * `pm2 logs` is ephemeral and only covers the current process, this
 * is persistent and queryable.
 *
 * Deliberately denormalised with `ticket_id` + `session_id` so a
 * single-key index on either dimension is cheap, and so the row
 * survives even if the session itself is purged in some future
 * retention pass.
 *
 * `payload` is jsonb to let the shape evolve without migrations —
 * new event types just emit the new shape and readers that don't
 * know the event ignore it. All current emitters set `message` to
 * a human-readable one-liner so a glance tells the story.
 */
export type BotActivityEvent =
  | 'session_started'
  | 'step_entered'
  | 'option_matched'
  | 'payload_routed'
  | 'late_tap_recovered'
  | 'unknown_reply'
  | 'handoff_fired'
  | 'session_completed'
  | 'session_failed'
  | 'step_delayed'
  | 'ticket_resolved';

@Entity({ name: 'bot_activity_log' })
@Index(['ticket_id'])
@Index(['session_id'])
@Index(['createdAt'])
export class BotActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'session_id' })
  session_id!: string;

  @Column({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @Column({ type: 'uuid', name: 'flow_id' })
  flow_id!: string;

  /**
   * Step this event concerns. Null for session-level events
   * (session_started, session_completed) where no single step is
   * the subject.
   */
  @Column({ type: 'uuid', name: 'step_id', nullable: true })
  step_id!: string | null;

  @Column({ type: 'text' })
  event!: BotActivityEvent;

  /** Human one-liner the admin reads in the UI. */
  @Column({ type: 'text', nullable: true })
  message!: string | null;

  /**
   * Event-specific extras — option label, matched option index,
   * decoded payload id, next step id, error message, etc. Readers
   * grab whatever keys they recognise and ignore the rest.
   */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
