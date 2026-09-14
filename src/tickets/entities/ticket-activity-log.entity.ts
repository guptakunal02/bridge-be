import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TicketActivity } from '../../database/enums';
import { Ticket } from './ticket.entity';

@Entity({ name: 'ticket_activity_log' })
@Index(['ticket_id', 'createdAt'])
@Index(['actor_id', 'event', 'createdAt'])
export class TicketActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @ManyToOne(() => Ticket, (t) => t.activityLogs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: Ticket;

  @Column({ type: 'enum', enum: TicketActivity })
  event!: TicketActivity;

  /**
   * User that performed the action. NULL when the system did it
   * (ingest auto-creating a ticket, auto-assign to bot, etc.).
   * The (actor_id, event, createdAt) index backs the "resolved by me
   * today" and per-agent throughput queries.
   */
  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actor_id!: string | null;

  @Column({ type: 'text', nullable: true })
  log!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
