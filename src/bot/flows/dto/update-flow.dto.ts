import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BotTrigger } from '../../../database/enums';

export class UpdateFlowDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(BotTrigger)
  trigger?: BotTrigger;

  @IsOptional()
  @IsObject()
  triggerConditions?: unknown;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Change the entry-point step. Passing null clears it (the flow
   * becomes inert). The step must belong to this flow — service
   * enforces at save time.
   */
  @IsOptional()
  @IsUUID()
  firstStepId?: string;
}
