import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailInboxModule } from '../email-inbox/email-inbox.module';
import { Team } from '../teams/entities/team.entity';
import { TicketsModule } from '../tickets/tickets.module';
import { User } from '../users/entities/user.entity';
import { ActionDispatcher } from './action-dispatcher.service';
import { AddTagHandler } from './action-handlers/add-tag.handler';
import { RemoveTagHandler } from './action-handlers/remove-tag.handler';
import { SendEmailTemplateHandler } from './action-handlers/send-email-template.handler';
import { SendWhatsappTemplateHandler } from './action-handlers/send-whatsapp-template.handler';
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
 * Automation engine wiring. TicketsModule + EmailInboxModule are
 * both behind forwardRef — the handlers call into them
 * (TicketsService for status/assignee + the WhatsApp template send,
 * EmailTemplatesService for the email template send), and both
 * modules emit automation events back into the engine on their own
 * state mutations. Classic bidirectional feature coupling.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AutomationRule, User, Team]),
    forwardRef(() => TicketsModule),
    forwardRef(() => EmailInboxModule),
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
    SendWhatsappTemplateHandler,
    SendEmailTemplateHandler,
  ],
  exports: [AutomationEngine],
})
export class AutomationsModule {}
