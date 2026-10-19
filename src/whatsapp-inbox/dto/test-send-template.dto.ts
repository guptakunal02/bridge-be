import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Payload for POST /channels/:channelId/whatsapp-templates/:id/test.
 *
 * Scope decisions:
 *   * `phoneNumber` accepts anything that normalises to 7..15 digits
 *     after stripping non-digit characters. Lets admins paste
 *     "+91 98765 43210" or "919876543210" without caring about
 *     format. Meta normalises its end too.
 *   * `variableOverrides` is a name→value map ONLY for the variables
 *     the admin wants to override. Missing keys fall back to the
 *     template's stored fallback (nullable vars) or raise 400 for
 *     non-nullable ones with no override.
 */
export class TestSendTemplateDto {
  @IsString()
  @MinLength(7)
  @MaxLength(32)
  @Matches(/^[\d+\s()\-]+$/, {
    message: 'Phone number should contain only digits, +, spaces, (), -',
  })
  phoneNumber!: string;

  @IsOptional()
  @IsObject()
  variableOverrides?: Record<string, string>;
}
