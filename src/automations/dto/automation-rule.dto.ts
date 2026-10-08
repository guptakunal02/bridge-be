import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AUTOMATION_EVENT, type AutomationEventName } from '../events';

const EVENTS = Object.values(AUTOMATION_EVENT) as AutomationEventName[];

/**
 * CRUD payload for an automation rule. `cases` and `else_actions`
 * are intentionally typed as `unknown[]` at the class-validator
 * layer — their inner shape is a discriminated union of predicates
 * + actions that doesn't model cleanly with decorators. The
 * AutomationsService runs a dedicated structural validator over
 * both arrays before persisting, with per-case / per-action error
 * messages the FE surfaces.
 */
export class CreateAutomationRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsString()
  @IsIn(EVENTS)
  event!: AutomationEventName;

  @IsArray()
  @ArrayMaxSize(50)
  cases!: unknown[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  else_actions?: unknown[];
}

export class UpdateAutomationRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(EVENTS)
  event?: AutomationEventName;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  cases?: unknown[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  else_actions?: unknown[];
}
