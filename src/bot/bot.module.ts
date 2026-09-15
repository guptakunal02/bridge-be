import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RulesModule } from '../rules/rules.module';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { BotController } from './bot.controller';
import { BotFlow } from './entities/bot-flow.entity';
import { BotSession } from './entities/bot-session.entity';
import { BotStep } from './entities/bot-step.entity';
import { FlowsController } from './flows/flows.controller';
import { FlowsService } from './flows/flows.service';
import { StepConfigValidator } from './flows/step-config-validator.service';
import { BotFunctionsService } from './functions/bot-functions.service';
import { OpsModule } from './ops/ops.module';
import { BotRuntimeService } from './runtime/bot-runtime.service';
import { LoggingChannelAdapter } from './runtime/channel-adapter';
import { CHANNEL_ADAPTER } from './runtime/channel-adapter.token';

/**
 * Bot / conversational-flow module.
 *
 *   Wave 1: read-only ops connection + function registry.
 *   Wave 2: BotFlow / BotStep / BotSession schema.
 *   Wave 3: flow CRUD.
 *   Wave 4 (now): runtime state machine. LoggingChannelAdapter is
 *                 the stub outbound channel — the real WhatsApp
 *                 implementation slots in under the same DI token.
 *   Wave 5: trigger wiring into ingest.
 */
@Module({
  imports: [
    OpsModule,
    RulesModule,
    TypeOrmModule.forFeature([
      BotFlow,
      BotStep,
      BotSession,
      Ticket,
      TicketActivityLog,
    ]),
  ],
  controllers: [BotController, FlowsController],
  providers: [
    BotFunctionsService,
    FlowsService,
    StepConfigValidator,
    BotRuntimeService,
    { provide: CHANNEL_ADAPTER, useClass: LoggingChannelAdapter },
  ],
  exports: [BotFunctionsService, FlowsService, BotRuntimeService],
})
export class BotModule {}
