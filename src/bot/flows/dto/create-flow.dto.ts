import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BotTrigger } from '../../../database/enums';

export class CreateFlowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsEnum(BotTrigger)
  trigger!: BotTrigger;

  /**
   * Same ConditionTree shape rules use. Null / omitted means "fire
   * every time the trigger event fires."
   */
  @IsOptional()
  @IsObject()
  triggerConditions?: unknown;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
