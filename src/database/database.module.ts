import * as path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { EnvVars } from '../config/env.validation';
import { NodeEnv } from '../config/env.validation';

/**
 * TypeORM connection wiring. `synchronize: true` in dev keeps the DB
 * schema in sync with entity classes on every boot — no migrations
 * needed while iterating. For production, flip to `synchronize: false`
 * and generate a migration with `typeorm migration:generate`.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const isProd = config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
        return {
          type: 'postgres',
          url: config.get('DATABASE_URL', { infer: true }),
          // Auto-discover every *.entity.ts under src/. Feature modules
          // can drop entities wherever they live (e.g.
          // src/email-inbox/entities/email-message.entity.ts) without
          // ever touching this file.
          entities: [
            path.join(__dirname, '..', '**', '*.entity.js'),
            path.join(__dirname, '..', '**', '*.entity.ts'),
          ],
          // Schema is owned by TypeORM migrations. Run `pnpm migration:run`
          // to apply pending migrations (both dev and prod).
          synchronize: false,
          migrationsRun: false,
          logging: false,
          ssl: isProd ? { rejectUnauthorized: false } : false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
