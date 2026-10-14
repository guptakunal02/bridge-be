import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { MessageDirection } from '../../database/enums';
import { Ticket } from '../../tickets/entities/ticket.entity';

/**
 * One row per inbound or outbound WhatsApp message on a ticket.
 * Parallels EmailMessage but with Meta-specific fields instead of
 * RFC-5322 ones:
 *   * `sender` holds the WhatsApp wa_id (phone in E.164-ish form,
 *     no leading +). For inbound this is the customer's number; for
 *     outbound it's the business number the ticket belongs to.
 *   * `external_message_id` is Meta's wamid — unique in Meta's
 *     scope and used as the idempotency key against re-delivery
 *     (webhook retries can replay a message).
 *   * `message_type` records the Meta payload type (text, image,
 *     video, document, …) so renderers can branch without digging
 *     into raw_payload. V2 only ingests text; others log + skip.
 *   * `raw_payload` keeps the full Meta object so forensics / future
 *     migrations can replay the ingest without having lost info.
 */
@Entity({ name: 'whatsapp_message' })
@Index(['channelId', 'createdAt'])
@Index(['ticket_id', 'createdAt'])
export class WhatsappMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  channelId!: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel!: Channel;

  @Column({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: Ticket;

  // Reuse the enum TypeORM created for email_message's `type` column
  // instead of minting a parallel whatsapp_message_type_enum. Same
  // values (SENT / RECEIVED), simpler schema.
  @Column({
    type: 'enum',
    enum: MessageDirection,
    enumName: 'email_message_type_enum',
  })
  type!: MessageDirection;

  @Column({ type: 'text' })
  sender!: string;

  @Column({ type: 'text', nullable: true })
  content!: string | null;

  @Column({ type: 'text', unique: true, name: 'external_message_id' })
  external_message_id!: string;

  @Column({ type: 'text', name: 'message_type' })
  message_type!: string;

  @Column({ type: 'jsonb', nullable: true, name: 'raw_payload' })
  raw_payload!: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
