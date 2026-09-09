import { ChannelType } from '../../database/enums';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateChannelDto {
  @IsEnum(ChannelType)
  type!: ChannelType;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  inboxContact?: string;
}
