import { ChannelType, TicketStatus } from '../database/enums';

/**
 * V1 automation events. String literals (not an enum) so the DB
 * column + JSON payloads stay human-readable. Add a new entry here
 * when a new emission site is wired — the engine ignores any
 * rule whose `event` doesn't match a key below.
 *
 * Each event carries a fixed payload shape (TicketSnapshot + the
 * event-specific extras) — the predicate evaluator reads from
 * `event.*` for the extras and `ticket.*` for the snapshot. Keeping
 * both in the payload means the engine stays stateless (no DB
 * read on dispatch) and the predicate can see the ticket exactly
 * as the caller saw it when they emitted.
 */
export const AUTOMATION_EVENT = {
  TICKET_CREATED: 'ticket.created',
  MESSAGE_RECEIVED: 'message.received',
  TAG_APPLIED: 'tag.applied',
  TICKET_RESOLVED: 'ticket.resolved',
  TICKET_REOPENED: 'ticket.reopened',
  BOT_HANDOFF: 'bot.handoff',
  WEBHOOK_CUSTOM: 'webhook.custom',
  SHOPIFY_ORDER_CONFIRMED: 'shopify.order.confirmed',
  // Shopify deprecated `orders/partially_fulfilled` from the Admin UI;
  // `fulfillments/create` is the modern equivalent and fires on every
  // new fulfillment record (partial OR full). Covers "a shipment just
  // went out" uniformly.
  SHOPIFY_FULFILLMENT_CREATED: 'shopify.fulfillment.created',
  SHOPIFY_ORDER_FULFILLED: 'shopify.order.fulfilled',
  SHOPIFY_FULFILLMENT_UPDATED: 'shopify.fulfillment.updated',
} as const;

export type AutomationEventName =
  (typeof AUTOMATION_EVENT)[keyof typeof AUTOMATION_EVENT];

/**
 * Snapshot of the ticket at the moment an event was emitted. The
 * caller passes this through so predicates on `ticket.*` fields
 * evaluate against the exact state the caller saw — no race
 * window where the engine would reload and see a mutated row.
 */
export interface TicketSnapshot {
  id: string;
  channelId: string;
  /**
   * Channel this ticket arrived on. Lets rules scope by medium —
   * e.g. OOH auto-reply only on EMAIL, template re-engagement only
   * on WHATSAPP. `null` only on the webhook sentinel (no ticket).
   */
  channelType: ChannelType | null;
  status: TicketStatus;
  tags: string[];
  assigneeId: string | null;
  teamId: string;
  /** Subject of the first message on the ticket. */
  subject: string | null;
}

export interface TicketCreatedEventPayload {
  ticketId: string;
  channelId: string;
  sender: string | null;
  subject: string | null;
  body: string;
  /** Hour of the day (0-23) in IST at the moment the ticket was
   *  created. Convenience for OOH-style predicates. */
  hourIst: number;
  /** Day of week in IST, 0 = Sunday … 6 = Saturday (JS Date.getDay()
   *  convention). Convenience for weekend / weekday predicates. */
  dayOfWeekIst: number;
}

export interface MessageReceivedEventPayload {
  ticketId: string;
  messageId: string;
  channelId: string;
  sender: string | null;
  subject: string | null;
  body: string;
  hourIst: number;
  /** Day of week in IST, 0 = Sunday … 6 = Saturday (JS Date.getDay()
   *  convention). Convenience for weekend / weekday predicates. */
  dayOfWeekIst: number;
}

export interface TagAppliedEventPayload {
  ticketId: string;
  /** The tag that was JUST applied — predicates key off this value,
   *  not off the ticket's full tag set. Lets a rule distinguish
   *  "urgent was added" from "escalated was added" without reading
   *  the whole tags[] array. */
  tagName: string;
}

/**
 * Fires when a ticket's status transitions INTO RESOLVED (from any
 * non-resolved status). Predicates can key off `previousStatus` to
 * distinguish "resolved from OPEN" vs "resolved from WAITING".
 */
export interface TicketResolvedEventPayload {
  ticketId: string;
  previousStatus: TicketStatus;
  hourIst: number;
  /** Day of week in IST, 0 = Sunday … 6 = Saturday (JS Date.getDay()
   *  convention). Convenience for weekend / weekday predicates. */
  dayOfWeekIst: number;
}

/**
 * Fires when a RESOLVED ticket transitions back to a non-resolved
 * status (OPEN / WAITING / IN_FOLLOWUP). Covers both the manual
 * agent "Reopen" button and the ingest-driven reopen (customer
 * replies to a resolved ticket within the configured window).
 */
export interface TicketReopenedEventPayload {
  ticketId: string;
  newStatus: TicketStatus;
  hourIst: number;
  /** Day of week in IST, 0 = Sunday … 6 = Saturday (JS Date.getDay()
   *  convention). Convenience for weekend / weekday predicates. */
  dayOfWeekIst: number;
}

/**
 * Fires when a bot flow executes a Handoff step and releases the
 * ticket back to the human queue. Common consumer: an OOH rule that
 * sends an auto-reply template when the handoff lands outside working
 * hours. `teamId` is the team the handoff targeted (null = "leave on
 * current team"); `fromTeamId` is the team the ticket was on BEFORE
 * the handoff — useful if a rule wants to detect cross-team moves.
 */
export interface BotHandoffEventPayload {
  ticketId: string;
  flowId: string;
  stepId: string;
  teamId: string | null;
  fromTeamId: string;
  note: string | null;
  hourIst: number;
  /** Day of week in IST, 0 = Sunday … 6 = Saturday (JS Date.getDay()
   *  convention). Convenience for weekend / weekday predicates. */
  dayOfWeekIst: number;
}

/**
 * Fires when an external service POSTs to /webhooks/custom-events
 * with a valid X-Bridge-Secret. Payload carries:
 *   * name       — the event name the external service sent (admin
 *                  matches on this in a rule case condition, e.g.
 *                  `event.name equals "order.confirmed"`)
 *   * variables  — key/value map; used to resolve WhatsApp template
 *                  variable mappings (templateMapping[i].name →
 *                  variables[name]). Values can be string/number/
 *                  boolean; stringified when passed to Meta.
 *   * customerPhone — target wa_id for the template send. Required
 *                     because there's no ticket to pull it from.
 *   * channelId    — which WhatsApp channel the template goes out
 *                    from. Required for the same reason.
 *
 * No ticket is minted; the send is pure outbound. There IS a
 * TicketSnapshot on the top-level event (for consistency with the
 * union type), but every field is a sentinel — the predicate
 * evaluator should match on `event.*` here, not on `ticket.*`.
 */
export interface WebhookCustomEventPayload {
  name: string;
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  channelId: string;
}

/**
 * Fires when Shopify sends an `orders/create` webhook — the admin
 * subscribes in Shopify Admin → Settings → Notifications. Payload
 * mirrors WebhookCustomEventPayload's send-friendly shape so the
 * send_whatsapp_template action's no-ticket code path can be reused
 * verbatim, plus Shopify-native extras admins can predicate on
 * (order total, item count, etc.).
 *
 *   * customerPhone / customerEmail — pulled from the Shopify
 *     customer / shipping / billing address in that fallback order.
 *     Required because there's no ticket to resolve them from. When
 *     neither is present the controller skips emission entirely
 *     (nothing to deliver to) rather than firing with empty strings.
 *   * channelId — resolved on the BE side at dispatch time (template's
 *     bound channel). Empty string = "use template's channel".
 *   * variables — key/value map intended for template variable
 *     resolution. Keys documented inline below so admins can predicate
 *     on them + bind them in templates by matching name.
 *   * Shopify extras surface top-level for predicates:
 *       orderName   — "#1234" style human id (name field)
 *       orderNumber — numeric id without the prefix
 *       orderTotal  — total_price as string (preserve precision)
 *       currency    — "INR" / "USD"
 *       itemCount   — sum of line_items.quantity
 *       shopDomain  — the sending shop, for multi-tenant futures
 *
 * No ticket is minted; the send is pure outbound. The TicketSnapshot
 * is a sentinel (same convention as WEBHOOK_CUSTOM); predicates
 * should key on `event.*`, not `ticket.*`.
 */
export interface ShopifyOrderConfirmedEventPayload {
  name: 'shopify.order.confirmed';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  customerEmail: string | null;
  channelId: string;
  orderName: string;
  orderNumber: string;
  orderTotal: string;
  currency: string;
  itemCount: number;
  shopDomain: string;
}

/**
 * `orders/fulfilled` shares the exact order payload shape with
 * orders/create (Shopify sends the full order object on both).
 * Only the `name` discriminator distinguishes them in automation
 * rules. Fires once per order, when the LAST remaining line item
 * is fulfilled — typical consumer: "your entire order is on its
 * way" / review-request after a wait.
 */
export interface ShopifyOrderFulfilledEventPayload {
  name: 'shopify.order.fulfilled';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  customerEmail: string | null;
  channelId: string;
  orderName: string;
  orderNumber: string;
  orderTotal: string;
  currency: string;
  itemCount: number;
  fulfillmentStatus: string;
  shopDomain: string;
}

/**
 * `fulfillments/create` + `fulfillments/update` share the fulfillment
 * payload shape — the subject IS the fulfillment, not the whole order.
 * `fulfillments/create` fires when a new fulfillment record is created
 * (every shipment, whether partial or full), carrying the just-shipped
 * line items + tracking info. `fulfillments/update` fires on tracking
 * number changes and shipment-status transitions.
 *
 * Admins typically predicate on `shipmentStatus` to distinguish:
 *   confirmed            → "we have your package"
 *   in_transit           → "shipped, on the way"
 *   out_for_delivery     → "arriving today" ← LimeChat's OFD events
 *   attempted_delivery   → "we tried, missed you"
 *   ready_for_pickup     → "collect from X"
 *   delivered            → "it's arrived"
 *   failure              → "delivery failed"
 *
 * Phone / email are pulled from the fulfillment's `destination` block
 * (Shopify copies the shipping address there at fulfillment time), which
 * covers 95%+ of real orders. An API callback to the parent order to
 * fill in the gaps is a future addition if we see empty-destination
 * fulfillments in the Events inspector.
 */
export interface ShopifyFulfillmentEventPayload {
  name: 'shopify.fulfillment.created' | 'shopify.fulfillment.updated';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  customerEmail: string | null;
  channelId: string;
  orderId: string;
  orderName: string | null;
  fulfillmentId: string;
  status: string;
  shipmentStatus: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shopDomain: string;
}

export type AutomationEventPayload =
  | {
      event: typeof AUTOMATION_EVENT.TICKET_CREATED;
      ticket: TicketSnapshot;
      payload: TicketCreatedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.MESSAGE_RECEIVED;
      ticket: TicketSnapshot;
      payload: MessageReceivedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.TAG_APPLIED;
      ticket: TicketSnapshot;
      payload: TagAppliedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.TICKET_RESOLVED;
      ticket: TicketSnapshot;
      payload: TicketResolvedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.TICKET_REOPENED;
      ticket: TicketSnapshot;
      payload: TicketReopenedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.BOT_HANDOFF;
      ticket: TicketSnapshot;
      payload: BotHandoffEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.WEBHOOK_CUSTOM;
      ticket: TicketSnapshot;
      payload: WebhookCustomEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED;
      ticket: TicketSnapshot;
      payload: ShopifyOrderConfirmedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED;
      ticket: TicketSnapshot;
      payload: ShopifyFulfillmentEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.SHOPIFY_ORDER_FULFILLED;
      ticket: TicketSnapshot;
      payload: ShopifyOrderFulfilledEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED;
      ticket: TicketSnapshot;
      payload: ShopifyFulfillmentEventPayload;
    };

/** EventEmitter2 wildcard target for the automation engine's listener. */
export const AUTOMATION_EVENT_WILDCARD = 'automation.*';

/**
 * Internal namespace prefix for the EventEmitter2 bus. Separates
 * these from PRESENCE_EVENTS and any future namespaces.
 */
export function qualify(event: AutomationEventName): string {
  return `automation.${event}`;
}
