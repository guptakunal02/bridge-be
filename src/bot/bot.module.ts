import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotFunctionsService } from './functions/bot-functions.service';
import { OpsModule } from './ops/ops.module';

/**
 * Bot / conversational-flow module.
 *
 * Wave 1 (this file): read-only ops connection + function registry.
 * Wave 2: BotFlow / BotStep / BotSession schema + CRUD.
 * Wave 3: runtime state machine + trigger wiring.
 */
@Module({
  imports: [OpsModule],
  controllers: [BotController],
  providers: [BotFunctionsService],
  exports: [BotFunctionsService],
})
export class BotModule {}
