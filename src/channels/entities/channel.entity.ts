import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelStatus, ChannelType } from '../../database/enums';
import { Ticket } from '../../tickets/entities/ticket.entity';

@Entity({ name: 'channel' })
export class Channel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: ChannelType })
  type!: ChannelType;

  @Column({ type: 'text', unique: true })
  displayName!: string;

  @Column({ type: 'text', nullable: true, name: 'inbox_contact' })
  inbox_contact!: string | null;

  @Column({ type: 'text', nullable: true, name: 'credentials_encrypted' })
  credentials_encrypted!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  credentialsVerifiedAt!: Date | null;

  @Column({ type: 'enum', enum: ChannelStatus, default: ChannelStatus.DISCONNECTED })
  status!: ChannelStatus;

  /**
   * Senders whose inbound messages should be silently dropped —
   * never persisted, never surfaced as a ticket. Semantics of each
   * entry depend on the channel's `type`:
   *   * EMAIL — `full@address.com` matches that address exactly;
   *     `domain.com` (no @) matches any address on that domain.
   *   * WHATSAPP / INSTAGRAM — reserved for future work; pattern
   *     format defined by the respective ingest path.
   * See channel-muted-senders.ts for the matcher.
   */
  @Column({ type: 'text', array: true, default: () => `'{}'::text[]`, name: 'muted_senders' })
  muted_senders!: string[];

  /**
   * Last UID the IMAP INBOX worker successfully drained to for
   * THIS channel. The worker's start() uses this to resume where
   * the previous process left off instead of jumping to the
   * folder's current uidNext-1 (which silently buries every
   * message that arrived while this channel's worker was down).
   *
   * NULL on brand-new channels and on channels that pre-date this
   * column — those fall back to `uidNext - 1` on first boot
   * (same behaviour as before, but any subsequent boot resumes
   * from this persisted value).
   *
   * Updated at the end of every successful drain cycle; the
   * idempotency check on external_message_id covers the race
   * where the process crashes between update and ingest commit.
   */
  @Column({ type: 'integer', nullable: true, name: 'last_processed_inbox_uid' })
  last_processed_inbox_uid!: number | null;

  /**
   * Same contract as last_processed_inbox_uid, for the Sent Mail
   * folder. Historical bug (2026-10-08, ticket #1132): without
   * this field, Gmail-side agent replies that happened between a
   * pm2 restart and the first post-restart EXISTS event were
   * permanently lost.
   */
  @Column({ type: 'integer', nullable: true, name: 'last_processed_sent_uid' })
  last_processed_sent_uid!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Ticket, (t) => t.channel)
  tickets!: Ticket[];
}
