import * as path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { EnvVars } from '../config/env.validation';
import { NodeEnv } from '../config/env.validation';

export const OPS_CONNECTION = 'ops';

/**
 * Rewrite the DATABASE_URL's pathname (`/bridge`) to point at a
 * different logical DB (`/surma_common_ops`). Same host, port,
 * user, password, TLS — just a different database name.
 *
 * Kept as a plain function so callers can compose their own URLs
 * without spinning up a full Nest context (useful in tests / scripts).
 */
export function buildOpsUrl(baseUrl: string, opsDbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${opsDbName}`;
  return parsed.toString();
}

/**
 * TypeORM wiring. Two connections:
 *
 *   default — the Bridge DB. Schema owned by our migrations. Every
 *             entity in `src/` auto-registers here.
 *
 *   ops     — the read-only surma_common_ops DB. NO entities are
 *             registered (empty array), migrations are off, and
 *             `synchronize: false` guarantees TypeORM never emits
 *             a DDL statement against it. All access goes through
 *             `OpsReadService`, which only exposes SELECT-style
 *             query helpers.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const isProd =
          config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
        return {
          type: 'postgres',
          url: config.get('DATABASE_URL', { infer: true }),
          entities: [
            path.join(__dirname, '..', '**', '*.entity.js'),
            path.join(__dirname, '..', '**', '*.entity.ts'),
          ],
          synchronize: false,
          migrationsRun: false,
          logging: false,
          ssl: isProd ? { rejectUnauthorized: false } : false,
        };
      },
    }),
    TypeOrmModule.forRootAsync({
      name: OPS_CONNECTION,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const isProd =
          config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
        return {
          type: 'postgres',
          url: buildOpsUrl(
            config.get('DATABASE_URL', { infer: true }),
            config.get('DB_OPS_NAME', { infer: true }),
          ),
          // Empty entities = TypeORM has no model of the ops schema.
          // Handlers use raw SQL through OpsReadService, so if the
          // ops schema evolves we don't need a Bridge deploy to keep
          // reads working.
          entities: [],
          synchronize: false,
          migrationsRun: false,
          migrations: [],
          logging: false,
          ssl: isProd ? { rejectUnauthorized: false } : false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
