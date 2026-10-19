import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { TicketsService } from '../../tickets/tickets.service';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import type { AutomationEventPayload } from '../events';

/**
 * send_whatsapp_template handler. Fires an APPROVED WhatsApp template
 * on the triggering ticket, resolving variables from the ticket +
 * customer DB (via the resolver that powers the agent send-template
 * flow). Falls back to the template's stored fallback strings when a
 * variable resolves null. The handler is a thin wrapper around
 * TicketsService.sendTemplate so the SENT whatsapp_message row + the
 * AGENT_REPLIED activity log are identical to a human-triggered send
 * — a reader of the thread can't tell them apart (and we WANT that,
 * since the automation is meant to feel like a trusted team member).
 *
 * Channel-type mismatch:
 *   The rule's event trigger might match on both email + whatsapp
 *   tickets (e.g. a 'ticket.created' rule with no channel filter).
 *   When this handler is dispatched on an email ticket, we skip
 *   with a warn log — no half-send, no crash.
 *
 * Non-APPROVED templates: TicketsService.sendTemplate throws a 400
 * for PENDING / REJECTED templates; the dispatcher's try/catch
 * swallows it + logs. One rule with a stale templateId can't block
 * other rules on the same event.
 */
@Injectable()
export class SendWhatsappTemplateHandler
  implements
    ActionHandler<Extract<Action, { type: 'send_whatsapp_template' }>>
{
  readonly type = 'send_whatsapp_template' as const;
  private readonly logger = new Logger(SendWhatsappTemplateHandler.name);

  constructor(
    @Inject(forwardRef(() => TicketsService))
    private readonly tickets: TicketsService,
    private readonly actor: AutomationSystemActor,
  ) {}

  async execute(
    action: Extract<Action, { type: 'send_whatsapp_template' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    // Channel-type gating happens inside TicketsService.sendTemplate
    // (it throws BadRequest on non-WhatsApp tickets). The handler's
    // try/catch below turns that into a warn log so one rule firing
    // on a mixed-channel event doesn't crash the dispatcher.
    const sys = await this.actor.resolve();
    if (!sys) {
      this.logger.warn(
        `send_whatsapp_template skipped on ticket=${ctx.ticket.id}: no BOT system actor`,
      );
      return;
    }
    try {
      await this.tickets.sendTemplate(
        ctx.ticket.id,
        { templateId: action.templateId },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `send_whatsapp_template failed on ticket=${ctx.ticket.id} template=${action.templateId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
