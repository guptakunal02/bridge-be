import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotController } from './bot.controller';
import { BotFlow } from './entities/bot-flow.entity';
import { BotSession } from './entities/bot-session.entity';
import { BotStep } from './entities/bot-step.entity';
import { BotFunctionsService } from './functions/bot-functions.service';
import { OpsModule } from './ops/ops.module';

/**
 * Bot / conversational-flow module.
 *
 *   Wave 1: read-only ops connection + function registry.
 *   Wave 2 (now): BotFlow / BotStep / BotSession schema. Flow
 *                 CRUD lands on top of these in the next task.
 *   Wave 3: runtime state machine + trigger wiring.
 */
@Module({
  imports: [
    OpsModule,
    TypeOrmModule.forFeature([BotFlow, BotStep, BotSession]),
  ],
  controllers: [BotController],
  providers: [BotFunctionsService],
  exports: [BotFunctionsService],
})
export class BotModule {}
