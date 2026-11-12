import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduledSendStatus } from '../database/enums';
import type { Action, ActionHandler } from './action';
import { AddTagHandler } from './action-handlers/add-tag.handler';
import { CallWebhookHandler } from './action-handlers/call-webhook.handler';
import { OptOutCustomerHandler } from './action-handlers/opt-out-customer.handler';
import { RemoveTagHandler } from './action-handlers/remove-tag.handler';
import { SendEmailTemplateHandler } from './action-handlers/send-email-template.handler';
import { SendWhatsappTemplateHandler } from './action-handlers/send-whatsapp-template.handler';
import { SetAssigneeHandler } from './action-handlers/set-assignee.handler';
import { SetStatusHandler } from './action-handlers/set-status.handler';
import { SetTeamHandler } from './action-handlers/set-team.handler';
import { ScheduledWhatsappSend } from './entities/scheduled-whatsapp-send.entity';
import type { AutomationEventPayload } from './events';

/**
 * Resolves `action.type` → handler and executes. Handlers are
 * individual providers so each can own its own dependencies
 * (TicketsService, Repo, etc.) via standard DI, instead of a
 * manual registry.
 *
 * Dispatch failures are swallowed per-action — one bad action in
 * one case must never crash the rest of the engine's dispatch
 * loop. Handlers log their own errors; the dispatcher adds a
 * final backstop just in case a handler throws synchronously.
 */
@Injectable()
export class ActionDispatcher {
  private readonly logger = new Logger(ActionDispatcher.name);
  private readonly handlers: Map<Action['type'], ActionHandler>;

  constructor(
    addTag: AddTagHandler,
    removeTag: RemoveTagHandler,
    setStatus: SetStatusHandler,
    setAssignee: SetAssigneeHandler,
    setTeam: SetTeamHandler,
    sendWhatsappTemplate: SendWhatsappTemplateHandler,
    sendEmailTemplate: SendEmailTemplateHandler,
    optOutCustomer: OptOutCustomerHandler,
    callWebhook: CallWebhookHandler,
    @InjectRepository(ScheduledWhatsappSend)
    private readonly scheduled: Repository<ScheduledWhatsappSend>,
  ) {
    // Keys are hard-coded strings instead of reading `handler.type`
    // from the instance. The handlers participate in the
    // AutomationsModule ↔ TicketsModule forwardRef cycle, so Nest
    // may hand us the instance before its class-field initialisers
    // have populated `.type`. Historical bug (2026-10-08, every
    // automation silently no-op'd): "No handler for action.type=add_tag"
    // logged for every single rule because the Map ended up with
    // undefined keys. The strings here are the single source of
    // truth and MUST stay in sync with the Action discriminant
    // literals in action.ts.
    this.handlers = new Map<Action['type'], ActionHandler>([
      ['add_tag', addTag as ActionHandler],
      ['remove_tag', removeTag as ActionHandler],
      ['set_status', setStatus as ActionHandler],
      ['set_assignee', setAssignee as ActionHandler],
      ['set_team', setTeam as ActionHandler],
      ['send_whatsapp_template', sendWhatsappTemplate as ActionHandler],
      ['send_email_template', sendEmailTemplate as ActionHandler],
      ['opt_out_customer', optOutCustomer as ActionHandler],
      ['call_webhook', callWebhook as ActionHandler],
    ]);
  }

  async dispatch(action: Action, ctx: AutomationEventPayload): Promise<void> {
    // Delay intercept: send_whatsapp_template with delay_minutes > 0
    // gets queued into scheduled_whatsapp_send and returns here. A
    // 1-min worker picks it up and re-enters this dispatcher with
    // delay_minutes=0, which falls through to the handler. All other
    // action types ignore delay — it's a WhatsApp-template-only V1
    // feature per product scope.
    if (
      action.type === 'send_whatsapp_template' &&
      typeof action.delay_minutes === 'number' &&
      action.delay_minutes > 0
    ) {
      await this.enqueueDelayed(action, ctx);
      return;
    }

    const handler = this.handlers.get(action.type);
    if (!handler) {
      // A rule was persisted with an action type we don't support in
      // this build (older schema, pre-v2 revert, hand-edited row).
      // Log + skip — the rest of the rule's actions still run.
      this.logger.warn(
        `No handler for action.type=${action.type} (ticket=${ctx.ticket.id})`,
      );
      return;
    }
    try {
      await handler.execute(action, ctx);
    } catch (err) {
      this.logger.warn(
        `Action ${action.type} crashed on ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async enqueueDelayed(
    action: Extract<Action, { type: 'send_whatsapp_template' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    // Snapshot with delay zeroed — prevents the worker's re-dispatch
    // from re-queueing in a loop.
    const snapshot = { ...action, delay_minutes: 0 };
    const scheduledAt = new Date(
      Date.now() + (action.delay_minutes ?? 0) * 60_000,
    );
    try {
      const row = this.scheduled.create({
        rule_id: null,
        action_config: snapshot as unknown as Record<string, unknown>,
        event_ctx: ctx as unknown as Record<string, unknown>,
        scheduled_at: scheduledAt,
        status: ScheduledSendStatus.PENDING,
      });
      const saved = await this.scheduled.save(row);
      this.logger.log(
        `TRACE_SCHEDULE_SEND id=${saved.id} templateId=${action.templateId} ` +
          `delayMin=${action.delay_minutes} scheduledAt=${scheduledAt.toISOString()} ` +
          `ticket=${ctx.ticket.id} event=${ctx.event}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to queue delayed send_whatsapp_template ticket=${ctx.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
