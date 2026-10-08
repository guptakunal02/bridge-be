import { Transform } from 'class-transformer';
import {
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
 * CRUD payload for an automation rule.
 *
 * On `cases` and `else_actions`: these are discriminated-union
 * structures (predicates + actions) that don't model cleanly with
 * class-validator decorators. The deep shape is validated by
 * AutomationsService.validateCasesAndActions() post-pipe, with
 * per-case / per-action error paths the FE surfaces.
 *
 * CRITICAL: `@Transform(({ value }) => value)` short-circuits
 * class-transformer so plainToInstance leaves the raw array +
 * every nested object completely untouched. Without this, the
 * global ValidationPipe (whitelist: true + transform: true +
 * enableImplicitConversion: true) was silently converting
 * each case object to `{}` — the inner `conditions` / `actions`
 * keys vanished before the service ever saw them, and the FE
 * had no clue because class-validator saw a valid array.
 *
 * Historical bug (2026-10-08): first saved automation rule had
 * cases=[] and else_actions=[] in the DB despite the FE sending
 * fully-populated cases. Confirmed via direct DB query against
 * row id 37849e80-e3da-46ad-a202-921a585fb614.
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

  @Transform(({ value }) => value)
  cases!: unknown;

  @IsOptional()
  @Transform(({ value }) => value)
  else_actions?: unknown;
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
  @Transform(({ value }) => value)
  cases?: unknown;

  @IsOptional()
  @Transform(({ value }) => value)
  else_actions?: unknown;
}
