import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelType, TicketStatus } from '../../database/enums';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { TicketActivityLog } from './ticket-activity-log.entity';

@Entity({ name: 'ticket' })
@Unique('ticket_channel_thread_key_unique', ['channel_id', 'thread_key'])
@Index(['assignee', 'status'])
@Index(['status', 'updatedAt'])
export class Ticket {
  // bigint auto-increment; TypeORM returns bigint as string in Node
  // because JS `number` can't safely hold 64-bit ints. Format as
  // `#${id}` at display time.
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'uuid', name: 'channel_id' })
  channel_id!: string;

  @ManyToOne(() => Channel, (c) => c.tickets, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel!: Channel;

  @Column({ type: 'enum', enum: ChannelType, name: 'channel_type' })
  channel_type!: ChannelType;

  /**
   * The team responsible for handling this ticket. Set at ingest —
   * for MVP always the default team since routing rules aren't
   * shipped yet. Wave 3 will let rules override.
   */
  @Column({ type: 'uuid', name: 'team_id' })
  team_id!: string;

  @Column({ type: 'uuid' })
  assignee!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'assignee' })
  assigneeUser!: User;

  @Column({ type: 'enum', enum: TicketStatus })
  status!: TicketStatus;

  @Column({ type: 'boolean', default: false, name: 'is_reopened' })
  is_reopened!: boolean;

  @Column({ type: 'boolean', default: false, name: 'refund_related' })
  refund_related!: boolean;

  /**
   * When status is WAITING or IN_FOLLOWUP, the timestamp at which
   * the auto-transition fires:
   *   WAITING → auto-RESOLVED at resume_at (customer didn't reply)
   *   IN_FOLLOWUP → becomes "ripe" at resume_at; the capacity hook
   *     wakes it to OPEN next time the assignee frees a slot
   * Cleared back to NULL any time the ticket returns to OPEN.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'resume_at' })
  resume_at!: Date | null;

  @Column({ type: 'text', name: 'thread_key' })
  thread_key!: string;

  /**
   * Free-form labels used by routing rules and by humans to
   * categorise threads. Stored as a Postgres text[] with a GIN
   * index — the routing engine relies on `tags @> ARRAY[...]`
   * containment queries.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;

  @OneToMany(() => TicketActivityLog, (l) => l.ticket)
  activityLogs!: TicketActivityLog[];
}
