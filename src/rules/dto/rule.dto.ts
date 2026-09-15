import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Payload for POST /rules/validate — checks a candidate tree without
 * saving it. Backend synthesises a sample ticket that would satisfy
 * the first group's conditions and confirms the evaluator agrees.
 */
export class ValidateRuleDto {
  @IsObject()
  conditionTree!: unknown;
}
