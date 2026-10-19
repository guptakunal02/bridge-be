import {
  ArrayMaxSize,
  IsArray,
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
}
