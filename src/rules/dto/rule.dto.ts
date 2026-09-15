import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsUUID()
  teamId!: string;

  @IsObject()
  conditionTree!: unknown;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9999)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsObject()
  conditionTree?: unknown;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9999)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Payload for POST /rules/:id/test — hand-crafted attribute values
 * for a dry run. Any key not sent defaults to null and the evaluator
 * treats it as "no match."
 */
export class TestRuleDto {
  @IsObject()
  context!: Record<string, unknown>;
}
