import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { plainToInstance, Type } from 'class-transformer';

/**
 * On-disk shape for a mailbox connection. Persisted encrypted in
 * Channel.credentialsEncrypted; decrypted only when the adapter needs it.
 *
 * For Gmail preset:
 *   smtp: smtp.gmail.com:465, secure=true
 *   imap: imap.gmail.com:993, secure=true
 *   username = address, password = app-password (requires 2FA on the account)
 */
export class EmailEndpointCredentials {
  @IsString()
  @MinLength(1)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsBoolean()
  secure!: boolean;

  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class EmailChannelCredentials {
  @IsEmail()
  address!: string;

  @ValidateNested()
  @Type(() => EmailEndpointCredentials)
  smtp!: EmailEndpointCredentials;

  @ValidateNested()
  @Type(() => EmailEndpointCredentials)
  imap!: EmailEndpointCredentials;
}

export function parseEmailCredentials(raw: unknown): EmailChannelCredentials {
  const instance = plainToInstance(EmailChannelCredentials, raw, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new Error(
      `Invalid email credentials: ${errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('; ')}`,
    );
  }
  return instance;
}
