import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotSessionStatus } from '../../database/enums';
import { Ticket } from '../../tickets/entities/ticket.entity';
import { BotFlow } from './bot-flow.entity';
import { BotStep } from './bot-step.entity';

/**
 * The live state of a bot-driven conversation. One row per ticket
 * with an active flow — UNIQUE(ticket_id) enforces that.
 *
 *   current_step_id — the step the runtime is currently blocked on
 *                     (usually a question waiting for a customer
 *                     reply). Null when the session is terminal
 *                     (COMPLETED / HANDOFF / FAILED).
 *   variables       — arbitrary JSON. Function outputs, captured
 *                     answers, and initial trigger data all merge in
 *                     here under flow-defined keys.
 */
@Entity({ name: 'bot_session' })
@Index(['status'])
export class BotSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint', name: 'ticket_id', unique: true })
  ticket_id!: string;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: Ticket;

  @Column({ type: 'uuid', name: 'flow_id' })
  flow_id!: string;

  @ManyToOne(() => BotFlow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'flow_id' })
  flow!: BotFlow;

  @Column({ type: 'uuid', nullable: true, name: 'current_step_id' })
  current_step_id!: string | null;

  @ManyToOne(() => BotStep, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_step_id' })
  currentStep!: BotStep | null;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  variables!: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: BotSessionStatus,
    default: BotSessionStatus.ACTIVE,
  })
  status!: BotSessionStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'startedAt' })
  startedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updatedAt' })
  updatedAt!: Date;
}
