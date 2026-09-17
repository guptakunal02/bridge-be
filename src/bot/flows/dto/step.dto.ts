import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { BotStepType } from '../../../database/enums';

export class CanvasPositionDto {
  @IsNumber()
  x!: number;

  @IsNumber()
  y!: number;
}

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

  /** Where the node lands on the canvas. Defaulted by the service if omitted. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasPositionDto)
  canvasPosition?: CanvasPositionDto;
}

export class UpdateStepDto {
  @IsOptional()
  @IsEnum(BotStepType)
  type?: BotStepType;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasPositionDto)
  canvasPosition?: CanvasPositionDto;
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
