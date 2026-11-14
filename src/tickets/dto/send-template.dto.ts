import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Payload for POST /tickets/:id/send-template. V1 only accepts BODY-only
 * templates (no header media / no buttons), so the client sends:
 *
 *   templateId — uuid of the local whatsapp_template row (resolved
 *                server-side to name + language + Meta template_id).
 *   variables  — ordered values for {{1}}, {{2}}, …. Must match the
 *                template's variableCount; shorter → BE pads with
 *                empty strings; longer → extras ignored.
 *
 * Meta caps each variable at 1024 chars (full template body limit);
 * we enforce 300 per variable since real-world {{n}} values are
 * typically names / order numbers / short phrases.
 */
export class SendTemplateDto {
  @IsUUID()
  templateId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  variables?: string[];

  /**
   * Per-NAME overrides for mapped (V4+) templates. Lets an agent
   * manually type a value for a variable that the ticket context
   * can't auto-resolve — e.g. the composer's "unable to add order_id
   * in this template" case where the ticket wasn't linked to a
   * Shopify order so {{order_id}} had nothing to auto-fill from.
   *
   * Resolution precedence at send time:
   *   1. agent-typed override here (if non-empty)
   *   2. auto-resolve from ticket context
   *   3. template's declared fallback
   *   4. BadRequestException if the variable is non-nullable and all
   *      above returned empty
   *
   * Ignored for LEGACY (positional) templates — they continue to
   * read from `variables` above.
   */
  @IsOptional()
  @IsObject()
  variableOverrides?: Record<string, string>;
}
