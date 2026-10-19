import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { EmailTemplateCategory } from '../../database/enums';
import { User } from '../../users/entities/user.entity';
import type { VariableMappingEntry } from '../../whatsapp-inbox/template-variables';

/**
 * One row per email template authored on a given email channel. Mirrors
 * whatsapp_template shape so agents keep the same mental model across
 * channels:
 *   * `number` short integer id for Outreach URLs + composer picker
 *   * `name` snake_case internal identifier
 *   * `subject` with {{name}} placeholders
 *   * `body_html` with {{name}} placeholders
 *   * `body_text` optional plain-text fallback (we auto-generate one
 *     on the fly if the author doesn't supply)
 *   * `variable_mapping` resolver → fallback list, identical to the
 *     WhatsApp mapping shape (reuses VariableMappingEntry)
 *
 * Scope decisions:
 *   * Channel-scoped (not workspace-level) so authors can give each
 *     sending identity its own templates — a "Billing" address and
 *     a "Support" address usually have different signatures/tone.
 *   * No pending/approved review states — email templates don't go
 *     through a third-party reviewer, so they're ready to use once
 *     saved. Status column intentionally omitted.
 *   * `createdBy` is SET NULL on member delete to keep the template
 *     usable after the author leaves.
 */
@Entity({ name: 'email_template' })
@Index(['channelId', 'category'])
@Index(['channelId', 'name'], { unique: true })
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint' })
  number!: string;

  @Column({ type: 'uuid', name: 'channel_id' })
  channelId!: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel!: Channel;

  @Column({ type: 'text' })
  name!: string;

  @Column({
    type: 'enum',
    enum: EmailTemplateCategory,
    enumName: 'email_template_category_enum',
    default: EmailTemplateCategory.UTILITY,
  })
  category!: EmailTemplateCategory;

  @Column({ type: 'text' })
  subject!: string;

  @Column({ type: 'text', name: 'body_html' })
  bodyHtml!: string;

  @Column({ type: 'text', nullable: true, name: 'body_text' })
  bodyText!: string | null;

  @Column({ type: 'int', name: 'variable_count', default: 0 })
  variableCount!: number;

  @Column({ type: 'jsonb', nullable: true, name: 'variable_mapping' })
  variableMapping!: VariableMappingEntry[] | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator!: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
