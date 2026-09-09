import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { EnvVars } from '../config/env.validation';
import { NodeEnv } from '../config/env.validation';
import { Channel } from './entities/channel.entity';
import { EmailMessage } from './entities/email-message.entity';
import { Ticket } from './entities/ticket.entity';
import { TicketActivityLog } from './entities/ticket-activity-log.entity';
import { User } from './entities/user.entity';

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
          entities: [User, Channel, Ticket, EmailMessage, TicketActivityLog],
          synchronize: !isProd,
          logging: false,
          ssl: isProd ? { rejectUnauthorized: false } : false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
