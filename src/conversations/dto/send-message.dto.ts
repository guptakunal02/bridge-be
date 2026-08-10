import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export type SendMessageKind = 'TEXT' | 'IMAGE' | 'FILE';

export class SendMessageDto {
  @IsIn(['TEXT', 'IMAGE', 'FILE'])
  kind!: SendMessageKind;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2000)
  mediaUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mediaFilename?: string;
}
