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

  /**
   * From-display-name shown to customers on outgoing emails. Empty
   * string clears it (service converts to null) so the sender falls
   * back to displayName. EMAIL channels only.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  senderDisplayName?: string;

  @IsOptional()
  @IsEnum(ChannelStatus)
  status?: ChannelStatus;
}
