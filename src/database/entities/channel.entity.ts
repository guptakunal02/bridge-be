import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelStatus, ChannelType } from '../enums';
import { EmailMessage } from './email-message.entity';
import { Ticket } from './ticket.entity';

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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Ticket, (t) => t.channel)
  tickets!: Ticket[];

  @OneToMany(() => EmailMessage, (m) => m.channel)
  emailMessages!: EmailMessage[];
}
