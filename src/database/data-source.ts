import 'dotenv/config';
import * as path from 'node:path';
import { DataSource } from 'typeorm';

/**
 * DataSource used by the TypeORM CLI for migrations.
 * Not consumed at runtime by the Nest app — see database.module.ts
 * for the runtime connection.
 *
 * The compiled build (dist/…) is picked up when this file lives at
 * dist/database/data-source.js. Run `pnpm build` first, then any of
 * the `pnpm migration:*` scripts.
 */
const isCompiled = __filename.endsWith('.js');
const suffix = isCompiled ? '.js' : '.ts';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [path.join(__dirname, `entities/*.entity${suffix}`)],
  migrations: [path.join(__dirname, `migrations/*${suffix}`)],
  synchronize: false,
  logging: ['error', 'schema'],
});
