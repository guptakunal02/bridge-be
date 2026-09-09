import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TicketActivity } from '../enums';
import { Ticket } from './ticket.entity';

@Entity({ name: 'ticket_activity_log' })
@Index(['ticket_id', 'createdAt'])
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

  @Column({ type: 'text', nullable: true })
  log!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
