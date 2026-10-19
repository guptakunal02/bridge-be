import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WhatsappTemplateCategory } from '../../database/enums';

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
}
