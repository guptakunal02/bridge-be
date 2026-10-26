import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TicketsService } from '../../tickets/tickets.service';
import { WhatsappTemplate } from '../../whatsapp-inbox/entities/whatsapp-template.entity';
import { WhatsappSenderService } from '../../whatsapp-inbox/whatsapp-sender.service';
import { WhatsappTemplateStatus } from '../../database/enums';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import { AUTOMATION_EVENT, type AutomationEventPayload } from '../events';

/**
 * send_whatsapp_template handler. Has TWO paths depending on the
 * triggering event:
 *
 *   Ticket-bearing events (TICKET_CREATED, MESSAGE_RECEIVED, …) →
 *     Delegates to TicketsService.sendTemplate, which resolves
 *     variables from ticket + customer DB (same resolver the agent
 *     send-template flow uses). SENT whatsapp_message row + the
 *     AGENT_REPLIED activity log get written identically to a
 *     human-triggered send so the thread is indistinguishable.
 *
 *   WEBHOOK_CUSTOM event →
 *     No ticket. Loads the template, resolves variables from
 *     payload.variables keyed by variableMapping[].name (falling
 *     back to the stored fallback string per entry), then calls
 *     WhatsappSenderService.sendTemplate directly for a pure
 *     outbound. No ticket row, no activity log — webhook-triggered
 *     sends are gateway behaviour, not customer-support behaviour.
 *
 * Channel-type mismatch (ticket-path):
 *   The rule's event trigger might match on both email + whatsapp
 *   tickets (e.g. a 'ticket.created' rule with no channel filter).
 *   When this handler is dispatched on an email ticket, we skip
 *   with a warn log — no half-send, no crash.
 *
 * Non-APPROVED templates: both paths skip with a warn log. One rule
 * with a stale templateId can't block other rules on the same event.
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
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    // forwardRef because AutomationsModule and WhatsappInboxModule
    // form a 2-way cycle (automations imports whatsapp-inbox for
    // this handler, whatsapp-inbox imports automations for the
    // ingest's rule emits). Module-level forwardRef is already in
    // place on both sides; this is belt + braces at the provider
    // level so a future refactor on WhatsappSenderService that
    // picks up an automation dep doesn't require touching this file.
    @Inject(forwardRef(() => WhatsappSenderService))
    private readonly sender: WhatsappSenderService,
  ) {}

  async execute(
    action: Extract<Action, { type: 'send_whatsapp_template' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    // Channel-less events (webhook, shopify) use the direct-send path:
    // no ticket, phone from payload, template's bound channel. Both
    // payload shapes share the (name/variables/customerPhone/channelId)
    // keys executeWebhookPath reads.
    if (
      ctx.event === AUTOMATION_EVENT.WEBHOOK_CUSTOM ||
      ctx.event === AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED
    ) {
      await this.executeWebhookPath(action.templateId, ctx);
      return;
    }
    await this.executeTicketPath(action.templateId, ctx);
  }

  private async executeTicketPath(
    templateId: string,
    ctx: AutomationEventPayload,
  ): Promise<void> {
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
        { templateId },
        sys,
      );
    } catch (err) {
      this.logger.warn(
        `send_whatsapp_template failed on ticket=${ctx.ticket.id} template=${templateId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async executeWebhookPath(
    templateId: string,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    if (
      ctx.event !== AUTOMATION_EVENT.WEBHOOK_CUSTOM &&
      ctx.event !== AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED
    ) {
      return;
    }
    const payload = ctx.payload;
    const template = await this.templates.findOne({
      where: { id: templateId },
    });
    if (!template) {
      this.logger.warn(
        `send_whatsapp_template webhook path: template ${templateId} not found; skipping`,
      );
      return;
    }
    if (template.status !== WhatsappTemplateStatus.APPROVED) {
      this.logger.warn(
        `send_whatsapp_template webhook path: template ${templateId} status=${template.status}; skipping`,
      );
      return;
    }
    // Shopify + webhook events are channel-less at trigger time;
    // the admin binds the OUTBOUND channel via the template choice.
    // When the event payload carries a channelId (webhook.custom sends
    // one explicitly), require it to match the template's channel so
    // a template authored on inbox A can't be fired via a webhook
    // targeting inbox B. Shopify sets channelId="" (empty = "use the
    // template's channel") so this check skips cleanly.
    if (payload.channelId && template.channelId !== payload.channelId) {
      this.logger.warn(
        `send_whatsapp_template webhook path: template ${templateId} is on channel=${template.channelId} but webhook targeted channel=${payload.channelId}; skipping`,
      );
      return;
    }
    const mapping = template.variableMapping;
    const variables: string[] = [];
    if (mapping && mapping.length > 0) {
      for (const entry of mapping) {
        const raw = payload.variables[entry.name];
        const value =
          raw === undefined || raw === null
            ? (entry.fallback ?? '')
            : String(raw);
        variables.push(value);
      }
    } else if (template.variableCount > 0) {
      // Legacy template (no variableMapping) sent via webhook: we
      // can't name-resolve the positional vars. Admin should remap
      // the template through the authoring UI to use webhook sends.
      this.logger.warn(
        `send_whatsapp_template webhook path: template ${templateId} has no variableMapping but ${template.variableCount} positional variables; skipping`,
      );
      return;
    }
    try {
      await this.sender.sendTemplate(
        payload.customerPhone,
        template.name,
        template.language,
        variables,
        template.headerMediaUrl,
      );
      this.logger.log(
        `send_whatsapp_template webhook send ok: event=${payload.name} template=${template.name} to=${payload.customerPhone}`,
      );
    } catch (err) {
      this.logger.warn(
        `send_whatsapp_template webhook send failed: event=${payload.name} template=${template.name} to=${payload.customerPhone}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
