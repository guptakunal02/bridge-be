import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TicketsService } from '../../tickets/tickets.service';
import { WhatsappTemplate } from '../../whatsapp-inbox/entities/whatsapp-template.entity';
import { WhatsappSenderService } from '../../whatsapp-inbox/whatsapp-sender.service';
import { WhatsappTemplateStatus } from '../../database/enums';
import { resolveButtonId } from '../../whatsapp-inbox/template-buttons';
import type { Action, ActionHandler } from '../action';
import { AutomationSystemActor } from '../automation-system-actor';
import { AUTOMATION_EVENT, type AutomationEventPayload } from '../events';
import { resolveJsonPath } from '../json-path';

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
    // Channel-less events (webhook, shopify, upcoming clickpost/RP) use
    // the direct-send path: no ticket, phone from payload, template's
    // bound channel. All webhook payload shapes share the
    // (name/variables/customerPhone/channelId) keys executeWebhookPath
    // reads; rawPayload is optional and used by Phase-4 bindings.
    if (
      ctx.event === AUTOMATION_EVENT.WEBHOOK_CUSTOM ||
      ctx.event === AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED ||
      ctx.event === AUTOMATION_EVENT.SHOPIFY_ORDER_FULFILLED ||
      ctx.event === AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED ||
      ctx.event === AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED ||
      ctx.event === AUTOMATION_EVENT.LENS_NDR ||
      ctx.event === AUTOMATION_EVENT.LENS_NPR
    ) {
      await this.executeWebhookPath(action, ctx);
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
    action: Extract<Action, { type: 'send_whatsapp_template' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    if (
      ctx.event !== AUTOMATION_EVENT.WEBHOOK_CUSTOM &&
      ctx.event !== AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED &&
      ctx.event !== AUTOMATION_EVENT.SHOPIFY_ORDER_FULFILLED &&
      ctx.event !== AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED &&
      ctx.event !== AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED &&
      ctx.event !== AUTOMATION_EVENT.LENS_NDR &&
      ctx.event !== AUTOMATION_EVENT.LENS_NPR
    ) {
      return;
    }
    const templateId = action.templateId;
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

    // Phase 4 — JSON-path bindings resolve against the raw event JSON.
    // Fallback chain, strongest first:
    //   1. action.variable_bindings[name]       — rule-level override
    //   2. template.variableMapping[i].path     — authoring-time default
    //   3. (legacy) payload.variables[name]     — pre-Phase-4 emitter map
    //
    // Same chain applies to recipient_phone_path and header_image_path.
    // The template-stored paths let us hide the full binding UI in the
    // automation editor when the admin already picked everything at
    // authoring time (common case). The rule-level override is kept
    // for rules that need a non-standard variant (notify an ops phone
    // instead of the customer's, pull a different image path, etc.).
    const raw = payload.rawPayload ?? null;

    // Recipient phone. action.recipient_phone_path (rule override) wins,
    // then template.recipientPhonePath (authoring default), then the
    // pre-populated payload.customerPhone (legacy emitter path).
    const effectiveRecipientPath =
      action.recipient_phone_path ?? template.recipientPhonePath ?? null;
    let recipientPhone = payload.customerPhone;
    if (effectiveRecipientPath) {
      if (!raw) {
        this.logger.warn(
          `send_whatsapp_template webhook path: template ${templateId} has recipient_phone_path but event lacks rawPayload; skipping`,
        );
        return;
      }
      const resolved = resolveJsonPath(raw, effectiveRecipientPath);
      if (!resolved) {
        this.logger.warn(
          `send_whatsapp_template webhook path: template ${templateId} recipient_phone_path=${effectiveRecipientPath} resolved to null; skipping`,
        );
        return;
      }
      recipientPhone = resolved;
    }

    // Merge the per-variable path chain. Rule-level overrides take
    // precedence per-key; any name the rule didn't override picks up
    // the template's stored path (variableMapping[i].path). Only when
    // neither is set do we fall through to the legacy payload.variables
    // map (the pre-Phase-4 shape where the emitter pre-populated vars
    // keyed by the template's variableMapping[].name).
    const effectiveBindings: Record<string, string> = {};
    if (template.variableMapping) {
      for (const entry of template.variableMapping) {
        if (entry.path && entry.path.length > 0) {
          effectiveBindings[entry.name] = entry.path;
        }
      }
    }
    if (action.variable_bindings) {
      for (const [k, v] of Object.entries(action.variable_bindings)) {
        effectiveBindings[k] = v;
      }
    }
    const useBindings = Object.keys(effectiveBindings).length > 0;

    // Variables. Three resolution modes:
    //   1. Phase 4 rule bindings  → resolve each var's JSON path
    //   2. Legacy named mapping   → payload.variables[entry.name]
    //   3. No mapping, no vars    → send empty variables array
    const mapping = template.variableMapping;
    const variables: string[] = [];
    if (useBindings) {
      if (!raw) {
        this.logger.warn(
          `send_whatsapp_template webhook path: template ${templateId} uses variable_bindings but event lacks rawPayload; skipping`,
        );
        return;
      }
      if (!mapping || mapping.length === 0) {
        this.logger.warn(
          `send_whatsapp_template webhook path: template ${templateId} uses variable_bindings but template has no variableMapping; skipping`,
        );
        return;
      }
      for (const entry of mapping) {
        const path = effectiveBindings[entry.name];
        const resolved = path ? resolveJsonPath(raw, path) : null;
        const value =
          resolved === null
            ? (entry.fallback ?? '')
            : resolved;
        variables.push(value);
      }
    } else if (mapping && mapping.length > 0) {
      for (const entry of mapping) {
        const rawVal = payload.variables[entry.name];
        const value =
          rawVal === undefined || rawVal === null
            ? (entry.fallback ?? '')
            : String(rawVal);
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
    // Header image. For IMAGE-header templates, three-tier fallback:
    //   1. resolveJsonPath(raw, header_image_path)   — per-event dynamic
    //   2. header_image_fallback                     — admin's static backup
    //   3. template.headerMediaUrl                   — original Meta sample
    // Static text / no-header templates skip this entirely.
    let headerUrl: string | null = template.headerMediaUrl;
    if (template.headerType === 'IMAGE') {
      const effectiveImagePath =
        action.header_image_path ?? template.headerImagePath ?? null;
      const dynamic =
        effectiveImagePath && raw
          ? resolveJsonPath(raw, effectiveImagePath)
          : null;
      headerUrl =
        dynamic ??
        action.header_image_fallback ??
        template.headerMediaUrl;
      if (!headerUrl) {
        this.logger.warn(
          `send_whatsapp_template webhook path: template ${templateId} has IMAGE header but no resolvable URL (binding=${effectiveImagePath ?? 'none'}, fallback=${action.header_image_fallback ?? 'none'}, sample=${template.headerMediaUrl ?? 'none'}); skipping`,
        );
        return;
      }
    }

    // Dynamic URL button params. For each URL button whose template-
    // authoring step detected a {{var}}, pick the already-resolved
    // variable value (same `variables[]` array that goes into the
    // body) and pass it as a Meta `button` component. Static-URL
    // buttons stay parameter-less. Button index is the button's
    // position in the template's BUTTONS list.
    const buttonUrlParams: Array<{ index: number; value: string }> = [];
    if (template.buttons) {
      template.buttons.forEach((b, idx) => {
        if (
          b.type === 'URL' &&
          typeof b.url_variable_name === 'string' &&
          b.url_variable_name.length > 0
        ) {
          const mapIdx = mapping?.findIndex(
            (m) => m.name === b.url_variable_name,
          );
          if (mapIdx !== undefined && mapIdx >= 0 && variables[mapIdx]) {
            buttonUrlParams.push({ index: idx, value: variables[mapIdx] });
          }
        }
      });
    }

    // QUICK_REPLY button payloads — one per QUICK_REPLY button on the
    // template. Encodes a tiny JSON doc {button_id, ctx} where ctx is
    // a flat map of resolved variables (name → value) from the same
    // resolution pass that built `variables[]`. The ingest side JSON-
    // parses this on the customer's inbound button tap and emits
    // whatsapp.button_reply with ctx flattened to the event payload
    // root. Meta imposes a ~1024-char limit on the payload string, so
    // we keep ctx compact — only the vars actually mapped on the
    // template, not the full event raw JSON.
    const buttonQuickReplyParams: Array<{ index: number; payload: string }> =
      [];
    if (template.buttons) {
      const ctx: Record<string, string> = {};
      if (mapping) {
        mapping.forEach((entry, i) => {
          const v = variables[i];
          if (typeof v === 'string') ctx[entry.name] = v;
        });
      }
      template.buttons.forEach((b, idx) => {
        if (b.type === 'QUICK_REPLY') {
          const buttonId = resolveButtonId(b);
          const payloadStr = JSON.stringify({ button_id: buttonId, ctx });
          buttonQuickReplyParams.push({ index: idx, payload: payloadStr });
        }
      });
    }

    try {
      await this.sender.sendTemplate(
        recipientPhone,
        template.name,
        template.language,
        variables,
        headerUrl,
        {
          useMarketingEndpoint: template.maxPriceAmount !== null,
        },
        buttonUrlParams,
        buttonQuickReplyParams,
      );
      this.logger.log(
        `send_whatsapp_template webhook send ok: event=${payload.name} template=${template.name} to=${recipientPhone}${useBindings ? ' (bindings)' : ''}${buttonUrlParams.length > 0 ? ` (${buttonUrlParams.length} url param${buttonUrlParams.length === 1 ? '' : 's'})` : ''}${buttonQuickReplyParams.length > 0 ? ` (${buttonQuickReplyParams.length} qr payload${buttonQuickReplyParams.length === 1 ? '' : 's'})` : ''}`,
      );
    } catch (err) {
      this.logger.warn(
        `send_whatsapp_template webhook send failed: event=${payload.name} template=${template.name} to=${recipientPhone}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
