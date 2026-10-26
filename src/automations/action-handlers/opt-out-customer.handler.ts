import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '../../database/enums';
import { CustomersService } from '../../outreach/customers.service';
import type { Action, ActionHandler } from '../action';
import { AUTOMATION_EVENT, type AutomationEventPayload } from '../events';

/**
 * Marks the customer behind an event as opted-out of marketing
 * sends — the "Remove from future updates & broadcasts" action in
 * the admin UI. Flips `Customer.marketing_opted_out = true`,
 * stamps when + why. Phase-3 broadcast dispatcher filters on this
 * flag at send time.
 *
 * Phone source depends on the event:
 *   * message.received      → `payload.sender`      (WhatsApp inbound body)
 *   * webhook.custom        → `payload.customerPhone` (external POST)
 *   * shopify.* events      → `payload.customerPhone` (order / fulfillment)
 *
 * Other events (ticket.created, tag.applied, etc.) have no phone
 * surface and the handler skips with a warn — the rule editor
 * disallows this pairing on the FE but defensive-skip here keeps
 * a hand-edited rule from crashing the dispatch loop.
 *
 * Idempotent at the service layer — a repeat opt-out on the same
 * phone is a no-op (returns the existing row unchanged). Lets a
 * message that matches multiple rule cases apply once effectively.
 */
@Injectable()
export class OptOutCustomerHandler
  implements ActionHandler<Extract<Action, { type: 'opt_out_customer' }>>
{
  readonly type = 'opt_out_customer' as const;
  private readonly logger = new Logger(OptOutCustomerHandler.name);

  constructor(private readonly customers: CustomersService) {}

  async execute(
    action: Extract<Action, { type: 'opt_out_customer' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const phone = this.resolvePhone(ctx);
    if (!phone) {
      this.logger.warn(
        `opt_out_customer skipped: no phone on event=${ctx.event} ticket=${ctx.ticket.id}`,
      );
      return;
    }
    // Email tickets would never produce a phone, so this redundant
    // check is a belt-and-braces for a hand-edited rule where the
    // channel scope got wiped. Keeps us from writing junk phones
    // (an email address stripped to digits is a disaster) into
    // customer.phone.
    if (
      ctx.ticket.channelType !== null &&
      ctx.ticket.channelType !== ChannelType.WHATSAPP
    ) {
      this.logger.warn(
        `opt_out_customer skipped: non-WhatsApp channel ${ctx.ticket.channelType} on ticket=${ctx.ticket.id}`,
      );
      return;
    }
    const reason = action.reasonLabel?.trim() || 'automation';
    try {
      await this.customers.applyOptOut(phone, reason);
    } catch (err) {
      this.logger.warn(
        `opt_out_customer failed on phone=${phone}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private resolvePhone(ctx: AutomationEventPayload): string | null {
    switch (ctx.event) {
      case AUTOMATION_EVENT.MESSAGE_RECEIVED:
      case AUTOMATION_EVENT.TICKET_CREATED:
        // sender is "919205241076"-shape for WhatsApp inbound;
        // CustomersService.normalizePhone will strip any noise if
        // Meta ever changes the shape. For email tickets this is
        // an address — the channelType guard above catches it.
        return ctx.payload.sender ?? null;
      case AUTOMATION_EVENT.WEBHOOK_CUSTOM:
      case AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED:
      case AUTOMATION_EVENT.SHOPIFY_ORDER_FULFILLED:
      case AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED:
      case AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED:
        return ctx.payload.customerPhone || null;
      default:
        return null;
    }
  }
}
