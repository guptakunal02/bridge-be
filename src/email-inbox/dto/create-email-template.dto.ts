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
import {
  EmailTemplateCategory,
  EmailTemplateKind,
} from '../../database/enums';

export class EmailTemplateVariableMappingDto {
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
 * POST /channels/:channelId/email-templates payload. Mirrors the
 * WhatsApp create DTO shape but with email specifics:
 *   * `subject` — up to 998 chars (RFC 5322 line-length guidance)
 *   * `bodyHtml` — up to 500 KB; most templates are a few KB.
 *     File uploads happen client-side; the FE pastes the HTML in
 *     here.
 *   * `variableMapping` — covers variables from BOTH subject + body
 */
export class CreateEmailTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-z0-9_]+$/, {
    message:
      'Template name must be lowercase letters, digits, or underscores (e.g. order_followup_v1)',
  })
  name!: string;

  @IsEnum(EmailTemplateCategory)
  category!: EmailTemplateCategory;

  @IsEnum(EmailTemplateKind)
  kind!: EmailTemplateKind;

  /**
   * Required when kind=OUTREACH; must be omitted (or empty) for
   * kind=REPLY. The service enforces this invariant — class-validator
   * can't express a cross-field conditional cleanly.
   */
  @IsOptional()
  @IsString()
  @MaxLength(998)
  subject?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512 * 1024)
  bodyHtml!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableMappingDto)
  variableMapping?: EmailTemplateVariableMappingDto[];
}
