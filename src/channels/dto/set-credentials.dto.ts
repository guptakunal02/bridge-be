import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { EmailChannelCredentials } from '../email/email-credentials';

/**
 * Minimal placeholder DTO: accepts encrypted-at-rest email credentials for
 * EMAIL channels. Non-email channel types will be rebuilt from scratch.
 */
export class SetCredentialsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => EmailChannelCredentials)
  email?: EmailChannelCredentials;
}
