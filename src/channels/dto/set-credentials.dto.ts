import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { EmailChannelCredentials } from '../email/email-credentials';

export class SetCredentialsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => EmailChannelCredentials)
  email?: EmailChannelCredentials;
}
