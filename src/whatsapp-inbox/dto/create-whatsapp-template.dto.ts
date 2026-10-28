import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  WhatsappTemplateCategory,
  WhatsappTemplateHeaderType,
} from '../../database/enums';
import {
  WHATSAPP_BUTTON_TEXT_MAX,
  WHATSAPP_FOOTER_TEXT_MAX,
  WHATSAPP_HEADER_TEXT_MAX,
} from '../template-buttons';

/**
 * One entry in the DTO's `variableMapping` array — a reference to a
 * known template variable (see template-variables.ts) and the
 * fallback string to splice in whenever the resolver returns null
 * for that variable on a given ticket.
 *
 *   name     — must match a key in TEMPLATE_VARIABLES_BY_NAME; the
 *              service rejects unknown names before touching Meta.
 *   fallback — null when the variable is non-nullable for the
 *              template's channel (service validates); otherwise
 *              required and 1..300 chars.
 */
export class WhatsappTemplateVariableMappingDto {
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]*$/)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  fallback?: string | null;

  /**
   * Realistic sample value for Meta's review step. The authoring UI
   * populates this when the admin clicks a JSON tree field — the
   * actual value from that recent event becomes the example Meta
   * sees. Not involved in send-time resolution; only in the Meta
   * template-submission payload under `example.body_text`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  example?: string | null;

  /**
   * JSON path captured when the admin clicked this variable's field
   * on the event-sample tree. Any automation rule picking this
   * template inherits this as its `variable_bindings[name]` default,
   * so the admin doesn't have to re-pick the same field at rule
   * creation time. Rule-level override still wins when set.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  path?: string | null;
}

/**
 * Payload for POST /channels/:id/whatsapp-templates.
 *
 * Meta's own validation rules we enforce client-side to fail fast
 * (rather than let Meta reject on submit):
 *   * `name` — snake_case / lowercase / digits / underscores only,
 *     max 512 chars but 60 is the practical limit for most clients.
 *   * `language` — BCP-47-ish (en, en_US, hi, hi_IN). Meta checks
 *     against its own supported-locale list.
 *   * `body` — 1..1024 chars. May contain {{varname}} references
 *     where varname is a key in TEMPLATE_VARIABLES_BY_NAME. The
 *     service converts to Meta's positional form before submission.
 *   * `variableMapping` — required when body contains any {{varname}}
 *     references; one entry per unique name, order doesn't matter
 *     (the service re-orders by first-appearance in the body).
 */
export class CreateWhatsappTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Matches(/^[a-z0-9_]+$/, {
    message:
      'Template name must be lowercase letters, digits, or underscores (e.g. order_followup_v1)',
  })
  name!: string;

  @IsEnum(WhatsappTemplateCategory)
  category!: WhatsappTemplateCategory;

  @IsString()
  @MinLength(2)
  @MaxLength(10)
  @Matches(/^[a-z]{2}(_[A-Z]{2})?$/, {
    message: 'Language must be a BCP-47 tag like "en" or "en_US"',
  })
  language!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  body!: string;

  /**
   * Named-variable fallbacks. Omit (or pass []) for static templates
   * with no `{{varname}}` references. Legacy positional `{{1}}` style
   * is NOT accepted from this endpoint — authors go through Meta BM
   * for those (and we pick them up via Sync).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WhatsappTemplateVariableMappingDto)
  variableMapping?: WhatsappTemplateVariableMappingDto[];

  /**
   * Visual-rich additions (Phase 2a). Header, footer, and buttons.
   * All optional — a legacy body-only template is a valid shape.
   *
   * `headerType=IMAGE` requires `headerMediaHandle` + `headerMediaUrl`
   * — the admin obtains these by first POSTing the sample image to
   * /channels/:id/whatsapp-templates/media which returns both.
   */
  @IsOptional()
  @IsEnum(WhatsappTemplateHeaderType)
  headerType?: WhatsappTemplateHeaderType;

  @IsOptional()
  @IsString()
  @MaxLength(WHATSAPP_HEADER_TEXT_MAX)
  headerText?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  headerMediaHandle?: string;

  @IsOptional()
  @IsUrl({ require_tld: true, require_protocol: true })
  headerMediaUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(WHATSAPP_FOOTER_TEXT_MAX)
  footerText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => WhatsappTemplateButtonDto)
  buttons?: WhatsappTemplateButtonDto[];

  /**
   * Phase 2b — Max Price bid cap in paisa per 1,000 deliveries.
   * E.g. ₹100/1k → 10,000. Hard-coded ceiling of 10,00,000 paisa
   * (= ₹10,000 / 1k = ₹10 / message) catches typos (an extra zero
   * is a common Indian-currency finger slip). Service rejects on
   * non-MARKETING category.
   *
   * Omit entirely to send at Meta's default auction price.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxPriceAmount?: number;

  /**
   * Default JSON path to the recipient's phone (e.g. `customer.phone`).
   * Captured during authoring. Automation rules picking this template
   * inherit it unless they explicitly override `recipient_phone_path`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  recipientPhonePath?: string;

  /**
   * Default JSON path for the per-event image URL. Only used when
   * headerType === IMAGE; ignored otherwise.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  headerImagePath?: string;

  /**
   * Name of the automation event the admin picked at authoring time
   * (via the Event sample helper's source dropdown). Admin-advisory
   * only — automation rules use it to pre-select the matching event
   * when the template is picked, saving two clicks and avoiding
   * mismatches.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  authoredEvent?: string;
}

/**
 * One button on the template's BUTTONS component. Discriminated on
 * `type`; validator rejects the field combinations that are illegal
 * for each type (URL requires `url`, PHONE_NUMBER requires
 * `phone_number`, QUICK_REPLY takes neither).
 */
export class WhatsappTemplateButtonDto {
  @IsString()
  @IsIn(['URL', 'PHONE_NUMBER', 'QUICK_REPLY'])
  type!: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';

  @IsString()
  @MinLength(1)
  @MaxLength(WHATSAPP_BUTTON_TEXT_MAX)
  text!: string;

  @IsOptional()
  @IsUrl({ require_tld: true, require_protocol: true })
  url?: string;

  // Meta expects E.164 or near-E.164 (country code + digits). Keep
  // the regex permissive — Meta's own validator is the final arbiter.
  @IsOptional()
  @Matches(/^\+?[0-9][0-9 \-()]{6,}$/, {
    message: 'phone_number must be an international phone number',
  })
  phone_number?: string;
}
