import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Ticket } from './ticket.entity';

/**
 * Internal private note on a ticket. Visible to every member and
 * admin in the inbox; never leaves the system. Rendered inline in
 * the conversation timeline so the context stays with the thread.
 *
 * Deliberately immutable in V1 — no edits or deletes. The audit
 * trail of what agents said to each other about a case is more
 * valuable than the ergonomic win of post-hoc fixes. If that
 * calculus flips, add a soft-delete column rather than deleting
 * rows (notes may be the only evidence of a decision made).
 */
@Entity({ name: 'ticket_note' })
@Index(['ticket_id', 'createdAt'])
export class TicketNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Ticket PK is bigint; TypeORM hands it back as a string.
  @Column({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: Ticket;

  /**
   * Author of the note. ON DELETE SET NULL so the note survives
   * deactivation / deletion of the user — the note's content is
   * still part of the ticket history. FE renders "Unknown user"
   * when null.
   */
  @Column({ type: 'uuid', nullable: true, name: 'author_id' })
  author_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'author_id' })
  author!: User | null;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
