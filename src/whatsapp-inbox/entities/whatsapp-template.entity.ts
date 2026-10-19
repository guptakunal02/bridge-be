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
import {
  WhatsappTemplateCategory,
  WhatsappTemplateStatus,
} from '../../database/enums';
import { User } from '../../users/entities/user.entity';
import type { VariableMappingEntry } from '../template-variables';

/**
 * A WhatsApp message template authored (or synced) against a given
 * WhatsApp channel's WABA. Templates are REQUIRED by Meta to re-engage
 * a customer once the 24h customer-service window closes — and so this
 * table is what the composer's "Send template" picker reads from.
 *
 * Scope decisions:
 *   * One row per (channel, name, language) — Meta allows multiple
 *     language variants of the same template; we treat each as its
 *     own usable row rather than a translation table.
 *   * `createdBy` is informational (audit / display) only — any
 *     member in the workspace can USE any template. Templates are
 *     global per channel, not per-member.
 *   * `metaTemplateId` is nullable because PENDING rows (ones we
 *     just submitted) don't have an id until Meta's reviewer stamps
 *     one. Populated during sync.
 *   * `body` stores the exact text Meta will render, with {{1}}, {{2}}
 *     etc placeholders. `variableCount` is derived at write time so
 *     the picker can render N inputs without re-parsing on every open.
 */
@Entity({ name: 'whatsapp_template' })
@Index(['channelId', 'status'])
@Index(['channelId', 'name', 'language'], { unique: true })
export class WhatsappTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Short integer id — public identifier used in Outreach URLs
   * (/outreach/whatsapp/templates/4) + the composer slash picker
   * ("/4" jumps straight to template #4). Backed by a BIGSERIAL
   * sequence; unique across the table (not per-channel). TypeORM
   * treats bigint columns as string on the JS side, so we convert
   * at the DTO boundary.
   */
  @Column({ type: 'bigint' })
  number!: string;

  @Column({ type: 'uuid', name: 'channel_id' })
  channelId!: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel!: Channel;

  /**
   * Meta template name — snake_case / lowercase, matches the string
   * Meta identifies the template by in Business Manager. Required by
   * Meta's send API; we send `name` + `language` and Meta looks up
   * the correct body server-side.
   */
  @Column({ type: 'text' })
  name!: string;

  @Column({
    type: 'enum',
    enum: WhatsappTemplateCategory,
    enumName: 'whatsapp_template_category_enum',
  })
  category!: WhatsappTemplateCategory;

  /**
   * BCP-47 language tag — Meta expects `en_US`, `en`, `hi`, etc.
   * Default `en` for V1; most Indian merchants use `en` for
   * English-content templates even for Hindi-speaking customers.
   */
  @Column({ type: 'text', default: 'en' })
  language!: string;

  /**
   * Raw template body as rendered by Meta — includes `{{1}}`, `{{2}}`
   * placeholders. Max 1024 chars per Meta's limit.
   */
  @Column({ type: 'text' })
  body!: string;

  /**
   * Number of `{{n}}` placeholders in body. Derived at write time
   * from counting `{{1..9}}` sequences. 0 means a static template.
   */
  @Column({ type: 'int', name: 'variable_count', default: 0 })
  variableCount!: number;

  @Column({
    type: 'enum',
    enum: WhatsappTemplateStatus,
    enumName: 'whatsapp_template_status_enum',
    default: WhatsappTemplateStatus.PENDING,
  })
  status!: WhatsappTemplateStatus;

  /**
   * Meta's internal template id, populated when sync pulls it back.
   * Not used for sending (Meta's send API keys on name+language) but
   * useful for debugging + for future features like delete/edit via
   * Meta's management API.
   */
  @Column({ type: 'text', nullable: true, name: 'meta_template_id' })
  metaTemplateId!: string | null;

  /**
   * Meta's human-readable reason when status === REJECTED. Surfaces
   * to the author in the templates admin page so they can fix + resubmit.
   */
  @Column({ type: 'text', nullable: true, name: 'rejection_reason' })
  rejectionReason!: string | null;

  /**
   * Ordered list of named variables + their fallback strings. Index
   * i in this array corresponds to Meta's {{i+1}} positional id in
   * `body`. Null for templates synced from Meta BM (which don't
   * carry name metadata) — those still work in the composer via the
   * legacy "fill {{1}} manually" UX.
   */
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
