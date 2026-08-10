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
