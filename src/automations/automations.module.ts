import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Team } from '../teams/entities/team.entity';
import { TicketsModule } from '../tickets/tickets.module';
import { User } from '../users/entities/user.entity';
import { ActionDispatcher } from './action-dispatcher.service';
import { AddTagHandler } from './action-handlers/add-tag.handler';
import { RemoveTagHandler } from './action-handlers/remove-tag.handler';
import { SetAssigneeHandler } from './action-handlers/set-assignee.handler';
import { SetStatusHandler } from './action-handlers/set-status.handler';
import { SetTeamHandler } from './action-handlers/set-team.handler';
import { AutomationEngine } from './automation-engine.service';
import { AutomationSystemActor } from './automation-system-actor';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AutomationRule } from './entities/automation-rule.entity';
import { RuleEvaluator } from './rule-evaluator.service';

/**
 * Automation engine wiring. TicketsModule is behind a forwardRef
 * because the engine's action handlers call back into
 * TicketsService.update, and TicketsService emits automation
 * events via AutomationEngine on tag/status/etc. mutations —
 * classic bidirectional feature coupling that forwardRef handles
 * cleanly.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AutomationRule, User, Team]),
    forwardRef(() => TicketsModule),
  ],
  controllers: [AutomationsController],
  providers: [
    AutomationsService,
    AutomationEngine,
    RuleEvaluator,
    ActionDispatcher,
    AutomationSystemActor,
    AddTagHandler,
    RemoveTagHandler,
    SetStatusHandler,
    SetAssigneeHandler,
    SetTeamHandler,
  ],
  exports: [AutomationEngine],
})
export class AutomationsModule {}
