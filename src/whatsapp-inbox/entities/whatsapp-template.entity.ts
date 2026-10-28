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
  WhatsappTemplateHeaderType,
  WhatsappTemplateStatus,
} from '../../database/enums';
import { User } from '../../users/entities/user.entity';
import type { WhatsappTemplateButton } from '../template-buttons';
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

  /**
   * Visual-rich fields on the template. Meta's HEADER / FOOTER /
   * BUTTONS components. All nullable because:
   *   - every pre-Phase-2 row has header_type = NONE and no footer
   *     or buttons,
   *   - a template may legitimately have body-only (utility OTPs,
   *     plain re-engagement) so emptiness is first-class.
   *
   * See template-buttons.ts for the discriminated button shape.
   */
  @Column({
    type: 'enum',
    enum: WhatsappTemplateHeaderType,
    enumName: 'whatsapp_template_header_type_enum',
    default: WhatsappTemplateHeaderType.NONE,
    name: 'header_type',
  })
  headerType!: WhatsappTemplateHeaderType;

  @Column({ type: 'text', nullable: true, name: 'header_text' })
  headerText!: string | null;

  /**
   * Opaque Meta handle returned by the Resumable Upload API. Required
   * on template-create when headerType = IMAGE; populated server-side
   * right after the admin's file lands on S3. NOT used on send — Meta
   * takes the send-time URL from `headerMediaUrl` (or an admin-supplied
   * override at broadcast time).
   */
  @Column({ type: 'text', nullable: true, name: 'header_media_handle' })
  headerMediaHandle!: string | null;

  /**
   * S3 URL for the sample image. Doubles as the preview image in the
   * template admin UI and as the default send-time `image.link`
   * passed to Meta's send API. A broadcast can override this per
   * campaign so one "promo_banner" template can be reused with a
   * different hero image every sale.
   */
  @Column({ type: 'text', nullable: true, name: 'header_media_url' })
  headerMediaUrl!: string | null;

  @Column({ type: 'text', nullable: true, name: 'footer_text' })
  footerText!: string | null;

  /**
   * Zero-to-three buttons rendered beneath the body. Stored as jsonb
   * (not a child table) because the shape is small and never queried
   * individually — the admin edits the whole array as one unit. Null
   * on legacy rows; empty array on authored-with-no-buttons rows.
   */
  @Column({ type: 'jsonb', nullable: true })
  buttons!: WhatsappTemplateButton[] | null;

  /**
   * Max Price bid cap in paisa per 1,000 deliveries. NULL = no cap
   * (send at Meta's default auction price). Only meaningful for
   * MARKETING templates — the create path refuses to set it on
   * UTILITY / AUTHENTICATION. At send time, the sender injects
   * this as `optimization_spec.bid_amount` on the Meta send call.
   *
   * Bigint on the wire because TypeORM maps `bigint` to a JS string
   * (regular ints only hold 2^53); for safety we Number()-coerce
   * at the DTO boundary where we know the value fits.
   */
  @Column({ type: 'bigint', nullable: true, name: 'max_price_amount' })
  maxPriceAmount!: string | null;

  /**
   * Default JSON path to the recipient's phone number inside the raw
   * event payload. Captured during template authoring (admin clicks a
   * phone field on the event-sample tree). An automation rule picking
   * this template inherits the path as its `recipient_phone_path`
   * unless the rule explicitly overrides it. Null = admin never
   * bound a default (older templates, Meta-synced ones, or admin
   * who typed `{{var}}` manually).
   */
  @Column({ type: 'text', nullable: true, name: 'recipient_phone_path' })
  recipientPhonePath!: string | null;

  /**
   * Default JSON path for the per-event image URL — only meaningful
   * for IMAGE-header templates. Same inheritance behaviour as
   * recipientPhonePath: automation rule's `header_image_path` wins
   * when set, otherwise falls back to this. The template's static
   * sample (`headerMediaUrl`) remains the final fallback at send
   * time if the path resolves to null.
   */
  @Column({ type: 'text', nullable: true, name: 'header_image_path' })
  headerImagePath!: string | null;

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
