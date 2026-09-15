import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { BotStepType } from '../../../database/enums';

export class CreateStepDto {
  @IsEnum(BotStepType)
  type!: BotStepType;

  /**
   * Type-specific payload. Structural validation happens in
   * StepConfigValidator; class-validator only checks the outer
   * shape here.
   */
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateStepDto {
  @IsOptional()
  @IsEnum(BotStepType)
  type?: BotStepType;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class ReorderStepsDto {
  /**
   * Every step in the flow, in the new order. Length + set-equality
   * against the flow's current steps is enforced by the service.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  stepIds!: string[];
}
