import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  /**
   * Read-only companion DB — same RDS host / creds as DATABASE_URL,
   * just a different logical database. Bridge NEVER writes here;
   * bot function handlers use it for order / customer lookups.
   */
  @IsString()
  @MinLength(1)
  DB_OPS_NAME!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  FRONTEND_ORIGIN!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @MinLength(1)
  JWT_ACCESS_TTL!: string;

  @IsString()
  @MinLength(1)
  JWT_REFRESH_TTL!: string;

  // 32 bytes base64-encoded → ~44 chars. AES-256-GCM for at-rest channel creds.
  @IsString()
  @MinLength(40)
  CHANNEL_ENCRYPTION_KEY!: string;

  // Google OAuth 2.0 web client ID (public).
  @IsString()
  @MinLength(1)
  GOOGLE_WEB_CLIENT_ID!: string;

  // Google OAuth 2.0 client secret — used server-side to exchange the auth code.
  @IsString()
  @MinLength(1)
  GOOGLE_CLIENT_SECRET!: string;

  // Absolute URL Google redirects back to after user consent. Must match
  // an Authorized redirect URI registered in the Google Cloud OAuth client.
  @IsUrl({ require_tld: false, require_protocol: true })
  GOOGLE_OAUTH_CALLBACK_URL!: string;

  /**
   * Second Google OAuth client — separate from the sign-in client
   * above because this one requests the mail.google.com scope and
   * has its own redirect URI. Kept apart so the sign-in client
   * stays scoped to userinfo only; a leaked sign-in token can
   * never touch mailbox data.
   */
  @IsString()
  @MinLength(1)
  EMAIL_INBOX_GOOGLE_CLIENT_ID!: string;

  @IsString()
  @MinLength(1)
  EMAIL_INBOX_GOOGLE_CLIENT_SECRET!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  EMAIL_INBOX_GOOGLE_CALLBACK_URL!: string;

  /**
   * S3 credentials + bucket for inbound email attachment storage.
   * The bucket is public-read (see infra runbook), so URLs the app
   * returns are direct https://<bucket>.s3.<region>.amazonaws.com/<key>
   * links — no presigning at read time.
   */
  @IsString()
  @MinLength(16)
  AWS_ACCESS_KEY_ID!: string;

  @IsString()
  @MinLength(1)
  AWS_SECRET_ACCESS_KEY!: string;

  @IsString()
  @MinLength(1)
  AWS_REGION!: string;

  @IsString()
  @MinLength(1)
  S3_ATTACHMENTS_BUCKET!: string;
}

export function validateEnv(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(`Invalid environment variables:\n${errors.toString()}`);
  }

  return validated;
}
