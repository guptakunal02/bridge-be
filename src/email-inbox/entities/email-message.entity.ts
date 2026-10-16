import {
  ArrayNotEmpty,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
} from 'class-validator';
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
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { Ticket } from '../../tickets/entities/ticket.entity';
import { MessageDirection } from '../../database/enums';
import { EmailMessageAttachment } from './email-message-attachment.entity';

@Entity({ name: 'email_message' })
@Index(['channelId', 'createdAt'])
@Index(['ticket_id', 'createdAt'])
export class EmailMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  channelId!: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel!: Channel;

  @Column({ type: 'text', nullable: true })
  @IsString()
  subject!: string | null;

  @Column({ type: 'enum', enum: MessageDirection })
  @IsEnum(MessageDirection)
  type!: MessageDirection;

  @Column({ type: 'text' })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @Column({ type: 'text', nullable: true, name: 'content_html' })
  content_html!: string | null;

  @Column({ type: 'text', nullable: true })
  @IsEmail()
  sender!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  @IsEmail({}, { each: true })
  @ArrayNotEmpty()
  receiver!: string[];

  // bigint is returned as string in Node (JS `number` can't safely
  // hold 64-bit ints), so this field is a string in TS.
  @Column({ type: 'bigint', name: 'ticket_id' })
  ticket_id!: string;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket!: Ticket;

  @Column({ type: 'text', unique: true, name: 'external_message_id' })
  @IsString()
  @IsNotEmpty()
  external_message_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;

  @OneToMany(() => EmailMessageAttachment, (a) => a.message)
  attachments!: EmailMessageAttachment[];

  /**
   * Transient — NOT a DB column. The ticket detail path adapts
   * whatsapp_message rows into this shape so toTicketDetail can
   * render both channels through one mapper. For WhatsApp, the
   * adapter stashes the Meta message_type ('text' / 'image' /
   * 'video' / 'document' / 'audio') here so the DTO mapper can
   * decide whether to render a text bubble or an attachment card.
   * Email rows never set this; the mapper defaults to 'text'.
   */
  _waMediaKind?: 'text' | 'image' | 'video' | 'document' | 'audio' | null;
}
