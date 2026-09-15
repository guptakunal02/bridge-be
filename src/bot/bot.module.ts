import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RulesModule } from '../rules/rules.module';
import { BotController } from './bot.controller';
import { BotFlow } from './entities/bot-flow.entity';
import { BotSession } from './entities/bot-session.entity';
import { BotStep } from './entities/bot-step.entity';
import { FlowsController } from './flows/flows.controller';
import { FlowsService } from './flows/flows.service';
import { StepConfigValidator } from './flows/step-config-validator.service';
import { BotFunctionsService } from './functions/bot-functions.service';
import { OpsModule } from './ops/ops.module';

/**
 * Bot / conversational-flow module.
 *
 *   Wave 1: read-only ops connection + function registry.
 *   Wave 2: BotFlow / BotStep / BotSession schema.
 *   Wave 3 (now): flow CRUD. Uses RuleEvaluatorService (via
 *                 RulesModule) to validate trigger conditions and
 *                 branch-step condition trees — same shape rules
 *                 use, so no duplication.
 *   Wave 4: runtime state machine + trigger wiring.
 */
@Module({
  imports: [
    OpsModule,
    RulesModule,
    TypeOrmModule.forFeature([BotFlow, BotStep, BotSession]),
  ],
  controllers: [BotController, FlowsController],
  providers: [BotFunctionsService, FlowsService, StepConfigValidator],
  exports: [BotFunctionsService, FlowsService],
})
export class BotModule {}
