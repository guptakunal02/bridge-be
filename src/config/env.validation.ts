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

  // Google OAuth 2.0 web client ID — audience the GIS-issued ID token must match.
  @IsString()
  @MinLength(1)
  GOOGLE_WEB_CLIENT_ID!: string;
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
