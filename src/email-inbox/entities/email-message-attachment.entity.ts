import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EmailMessage } from './email-message.entity';

/**
 * One file attached to an inbound email. The bytes live in S3
 * (public bucket); this row carries the metadata + the direct URL
 * the FE renders as a downloadable chip.
 *
 * Cascade delete on the parent message so a purged message doesn't
 * leave orphan attachment rows pointing at long-forgotten S3 keys.
 * S3 objects themselves are not deleted — this is intentional for
 * MVP (small attachments, no lifecycle policy yet). Add an S3
 * cleanup hook here when volume warrants.
 */
@Entity({ name: 'email_message_attachment' })
@Index(['message_id'])
export class EmailMessageAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'message_id' })
  message_id!: string;

  @ManyToOne(() => EmailMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message!: EmailMessage;

  @Column({ type: 'text' })
  filename!: string;

  @Column({ type: 'text', name: 'content_type' })
  content_type!: string;

  @Column({ type: 'bigint', name: 'size_bytes' })
  size_bytes!: string;

  @Column({ type: 'text', name: 'storage_key' })
  storage_key!: string;

  @Column({ type: 'text', name: 'storage_url' })
  storage_url!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
