import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-user, per-ticket "when did I last look at this" timestamp.
 * Bumped every time the user opens the ticket; the list endpoint
 * uses it to count inbound messages that arrived after that
 * timestamp — that number is the unread badge on the sidebar rail.
 *
 * Composite PK on (user_id, ticket_id) so upserts stay cheap. See
 * migration TicketReadState1726110000000 for the FK / ON DELETE
 * CASCADE guarantees.
 */
@Entity({ name: 'ticket_read_state' })
export class TicketReadState {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @PrimaryColumn({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @Column({ type: 'timestamptz', name: 'last_read_at' })
  last_read_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
