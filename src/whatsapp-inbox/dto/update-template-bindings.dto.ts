import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One per existing variable_mapping entry. The admin can edit the
 * `path` (JSON path resolved against rawPayload at send time) and the
 * `fallback` (used when the path resolves to null OR when no path is
 * set and the emitter's variables map lacks the key).
 *
 * `name` is the discriminator — must match an existing entry on the
 * template. Variables not in the body of the template (and thus not
 * in the current mapping) are rejected.
 *
 * `path` / `fallback` — null (explicitly) clears the field; undefined
 * leaves the existing value untouched. Admin UI should send null, not
 * omit the field, when they want to erase a previously-set path.
 */
export class UpdateVariableBindingDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  path?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fallback?: string | null;
}

/**
 * PATCH /channels/:channelId/whatsapp-templates/:id/bindings. All
 * fields optional — the service applies only the ones that are
 * present, so the FE can send partial updates (e.g. just the
 * recipient_phone_path).
 *
 * This endpoint deliberately CAN'T edit body / buttons / name /
 * header type / variable names / anything Meta cares about — those
 * require re-approval. It's scoped to the Bridge-side binding
 * metadata only.
 */
export class UpdateTemplateBindingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  recipientPhonePath?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  headerImagePath?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateVariableBindingDto)
  variableBindings?: UpdateVariableBindingDto[];
}
