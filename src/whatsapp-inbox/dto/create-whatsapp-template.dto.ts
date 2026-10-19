import { IsEnum, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { WhatsappTemplateCategory } from '../../database/enums';

/**
 * Payload for POST /channels/:id/whatsapp-templates.
 *
 * Meta's own validation rules we enforce client-side to fail fast
 * (rather than let Meta reject on submit):
 *   * `name` — snake_case / lowercase / digits / underscores only,
 *     max 512 chars but 60 is the practical limit for most clients.
 *   * `language` — BCP-47-ish (en, en_US, hi, hi_IN). Meta checks
 *     against its own supported-locale list.
 *   * `body` — 1..1024 chars. Must contain BODY content; placeholders
 *     are {{1}}, {{2}}, … and must be sequential (Meta rejects gaps).
 *     V1 doesn't validate gap-freeness — Meta does, and surfaces the
 *     reason to the FE.
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
}
