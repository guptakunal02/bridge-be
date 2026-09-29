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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Ticket, (t) => t.channel)
  tickets!: Ticket[];
}
