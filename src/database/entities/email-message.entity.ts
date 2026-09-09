import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MessageDirection } from '../enums';
import { Channel } from './channel.entity';
import { Ticket } from './ticket.entity';

@Entity({ name: 'email_message' })
@Index(['channelId', 'createdAt'])
@Index(['ticket_id', 'createdAt'])
export class EmailMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  channelId!: string;

  @ManyToOne(() => Channel, (c) => c.emailMessages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel!: Channel;

  @Column({ type: 'text', nullable: true })
  subject!: string | null;

  @Column({ type: 'enum', enum: MessageDirection })
  type!: MessageDirection;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'text', nullable: true })
  sender!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  receiver!: string[];

  @Column({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @ManyToOne(() => Ticket, (t) => t.emailMessages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: Ticket;

  @Column({ type: 'text', unique: true, name: 'external_message_id' })
  external_message_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
