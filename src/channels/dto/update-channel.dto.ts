import { ChannelStatus } from '../../database/enums';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateChannelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsEnum(ChannelStatus)
  status?: ChannelStatus;
}
