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

  @IsObject()
  conditionTree!: unknown;

  /**
   * Optional at creation time — rules can exist stand-alone and get
   * attached to a team later from the team-creation flow. Included
   * here so the same DTO covers both flows without needing a wrapper.
   */
  @IsOptional()
  @IsUUID()
  teamId?: string;

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
 * saving it. Backend does three things:
 *   1. Structural validation
 *   2. Matchability (a synthesised ticket exists that fires the rule)
 *   3. Overlap with every other rule in the system
 *
 * When editing an existing rule, pass its id in `ruleId` so the
 * overlap check excludes the current rule from the "others" set.
 */
export class ValidateRuleDto {
  @IsObject()
  conditionTree!: unknown;

  @IsOptional()
  @IsUUID()
  ruleId?: string;
}
