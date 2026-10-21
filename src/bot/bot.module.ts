import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationsModule } from '../automations/automations.module';
import { RulesModule } from '../rules/rules.module';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../tickets/entities/ticket-activity-log.entity';
import { WhatsappChannelAdapter } from '../whatsapp-inbox/whatsapp-channel-adapter';
import { WhatsappInboxModule } from '../whatsapp-inbox/whatsapp-inbox.module';
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
import { CHANNEL_ADAPTER } from './runtime/channel-adapter.token';

/**
 * Bot / conversational-flow module.
 *
 *   Wave 1: read-only ops connection + function registry.
 *   Wave 2: BotFlow / BotStep / BotSession schema.
 *   Wave 3: flow CRUD.
 *   Wave 4: runtime state machine.
 *   Wave 5: trigger wiring into ingest.
 *   Wave 6 (now): WhatsappChannelAdapter is bound to CHANNEL_ADAPTER
 *                 — the bot runtime now sends real messages via Meta
 *                 Graph. The adapter itself skip-logs when the ticket
 *                 isn't WhatsApp, so email-triggered flows don't crash
 *                 the runtime; a per-channel router will replace this
 *                 once an email send primitive lands.
 */
@Module({
  imports: [
    OpsModule,
    RulesModule,
    // forwardRef because AutomationsModule imports EmailInboxModule
    // which (transitively) depends on BotModule for the runtime.
    forwardRef(() => AutomationsModule),
    // forwardRef because WhatsappInboxModule already imports BotModule
    // (its ingest starts bot sessions). Pulls WhatsappChannelAdapter
    // in so the DI token binding below can resolve it at boot.
    forwardRef(() => WhatsappInboxModule),
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
    // useExisting (not useClass) so the single WhatsappChannelAdapter
    // instance provided by WhatsappInboxModule is what we hand to the
    // runtime — same object, same injected deps (Ticket repo, sender).
    { provide: CHANNEL_ADAPTER, useExisting: WhatsappChannelAdapter },
  ],
  exports: [BotFunctionsService, FlowsService, BotRuntimeService],
})
export class BotModule {}
