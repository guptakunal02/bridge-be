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
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { Ticket } from '../../tickets/entities/ticket.entity';
import { MessageDirection } from '../../database/enums';

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
}
