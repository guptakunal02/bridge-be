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
  /**
   * Shopify `orders/cancelled` webhook. Fires on both merchant-
   * initiated cancellations (from Shopify Admin) + customer-initiated
   * ones (via post-purchase cancel apps). Common usage: send a
   * "sorry it was cancelled — here's a code for next time" template.
   */
  SHOPIFY_ORDER_CANCELLED: 'shopify.order.cancelled',
  /**
   * Shopify `fulfillment_orders/split` webhook. Fires when the merchant
   * (or an app) splits a planned fulfillment into pieces — typically
   * because different warehouses will ship different items. Carries
   * NO tracking info; this is a pre-shipping signal. Common usage:
   * send a "FYI we're splitting your order into multiple shipments —
   * tracking coming shortly" heads-up before the per-box `fulfillments/
   * create` events fire with actual AWBs.
   *
   * Payload shape (REST webhook, production):
   *   fulfillment_order: {id, order_id, assigned_location_id, line_items}
   *   remaining_fulfillment_order: {same shape, items that stay}
   *   replacement_fulfillment_order: {same shape, new FO for split items}
   *   split_line_items: [{id, quantity}, …]
   */
  SHOPIFY_FULFILLMENT_ORDER_SPLIT: 'shopify.fulfillment_order.split',
  /**
   * Lens-forwarded Clickpost delivery exception events — surma-ops
   * classifies the scan then fires the typed event to Bridge AND to
   * LimeChat in parallel. NDR = Non-Delivery Report (consignee
   * unavailable, address wrong, etc). NPR = Non-Pickup Report.
   */
  LENS_NDR: 'lens.ndr',
  LENS_NPR: 'lens.npr',
  /**
   * Lens-forwarded RTO (Return To Origin) events. Fires when a parcel
   * is on its way back to the merchant warehouse after N failed
   * delivery attempts — the point where "we tried but it's coming
   * back" needs a customer-facing nudge (reconfirm address, offer a
   * discount to re-ship, etc.).
   */
  LENS_RTO: 'lens.rto',
  /**
   * Customer tapped a QUICK_REPLY button on an outbound template.
   * Meta webhooks the button-reply back; the ingest side parses the
   * stamped payload JSON ({button_id, ctx}) and emits this event
   * with the resolved context flattened to the payload root. Admin
   * rules filter on `button_id` + bind `call_webhook` params to the
   * context fields the original send carried.
   */
  WHATSAPP_BUTTON_REPLY: 'whatsapp.button_reply',
  /**
   * Return Prime `request/created` — forwarded by Lens's RP forwarder
   * (surma-ops) to /webhooks/return-prime. Fires when a customer
   * submits a new return / exchange request. Payload shape confirmed
   * from the 2026-10-24 live sample. Admin typically sends a
   * "received, we're reviewing" acknowledgement template.
   */
  RETURN_PRIME_REQUEST_CREATED: 'return_prime.request.created',
  /**
   * Return Prime `request/refunded` — fires when any
   * line_items[].refund.status flips to "refunded". Admin typically
   * sends a "refund processed" template with amount + mode (razorpay_x
   * / pay_to_source etc.). Does NOT fire for refunds the ops team marks
   * manually outside RP (notes-only refunds); those stay invisible to
   * this flow — surma-ops confirmed, agreed trade-off at integration time.
   */
  RETURN_PRIME_REQUEST_REFUNDED: 'return_prime.request.refunded',
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
  /**
   * Phase 4 — full raw JSON body as received from the external
   * webhook caller. The send_whatsapp_template action's
   * variable_bindings resolve JSON paths against this object (e.g.
   * "additional.latest_status.remark" for a Clickpost tracking
   * event). Optional for backward compat with pre-Phase-4 callers;
   * when absent the handler falls back to the pre-populated
   * `variables` map keyed by template variableMapping[].name.
   */
  rawPayload?: Record<string, unknown>;
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
  /** Order-level tags (split from Shopify's comma-separated string). */
  tags: string[];
  /** paid / pending / partially_refunded / refunded / voided / authorized. */
  financialStatus: string | null;
  /** null / partial / fulfilled / restocked. Null = unfulfilled. */
  fulfillmentStatus: string | null;
  /** First payment gateway name — "cash_on_delivery", "razorpay", … */
  paymentGateway: string | null;
  discountCodes: string[];
  note: string;
  /** web / pos / mobile_app / instagram / shop_app */
  sourceName: string | null;
  shippingCity: string | null;
  shippingProvince: string | null;
  shippingCountry: string | null;
  /** Customer-level tags (loyalty / VIP flags). */
  customerTags: string[];
  totalDiscount: string;
  subtotalPrice: string;
  totalTax: string;
  /** Phase 4 — the raw Shopify order JSON. See WebhookCustomEventPayload.rawPayload. */
  rawPayload?: Record<string, unknown>;
}

/**
 * `orders/fulfilled` shares the exact order payload shape with
 * orders/create (Shopify sends the full order object on both).
 * Only the `name` discriminator distinguishes them in automation
 * rules. Fires once per order, when the LAST remaining line item
 * is fulfilled — typical consumer: "your entire order is on its
 * way" / review-request after a wait.
 */
/**
 * `orders/cancelled` carries the same order payload shape as
 * orders/create — the full order object as it existed at cancel time
 * (with cancelled_at + cancel_reason filled in). Reuses the order
 * field extractor; only the two cancel-specific fields are added on
 * top so rules can filter on `cancel_reason` without JSON-path dives.
 */
export interface ShopifyOrderCancelledEventPayload {
  name: 'shopify.order.cancelled';
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
  tags: string[];
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  paymentGateway: string | null;
  discountCodes: string[];
  note: string;
  sourceName: string | null;
  shippingCity: string | null;
  shippingProvince: string | null;
  shippingCountry: string | null;
  customerTags: string[];
  totalDiscount: string;
  subtotalPrice: string;
  totalTax: string;
  /** customer / fraud / inventory / declined / other / staff — the
   *  enum Shopify sends. Null if the cancelling actor didn't pick one. */
  cancelReason: string | null;
  /** ISO timestamp of the cancel event. Null on refunds that drop the
   *  flag off before the webhook fires (rare). */
  cancelledAt: string | null;
  rawPayload?: Record<string, unknown>;
}

/**
 * Fires when Shopify splits a fulfillment order (merchant decides to
 * ship items from multiple locations). Pre-shipping signal — no AWB
 * yet. Hoisted top-level fields are what admins typically filter on:
 * which order, which locations are involved, how many items split.
 *
 * No customerPhone top-level: the webhook payload doesn't carry it.
 * Admin binds the recipient via a Shopify-order-table JSON path or an
 * enrichment step on the automation rule's variable_bindings. Handler
 * will skip the send with a warn log if the resolved phone is empty.
 */
export interface ShopifyFulfillmentOrderSplitEventPayload {
  name: 'shopify.fulfillment_order.split';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  customerEmail: string | null;
  channelId: string;
  shopDomain: string;
  /** Parent order id as a string (bigint in Shopify, kept lossless). */
  orderId: string;
  /** FulfillmentOrder id that was split (keeps remaining items). */
  originalFulfillmentOrderId: string;
  /** New FO id for items that stayed with the original location. */
  remainingFulfillmentOrderId: string;
  /** New FO id for items that moved to a different location. */
  replacementFulfillmentOrderId: string;
  /** Location id of the original FO. */
  originalLocationId: string | null;
  /** Location id of the replacement FO (where items were moved to). */
  replacementLocationId: string | null;
  /** Count of distinct line items that moved. */
  splitItemCount: number;
  /** Total quantity across all split line items. */
  splitQuantity: number;
  rawPayload?: Record<string, unknown>;
}

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
  tags: string[];
  financialStatus: string | null;
  paymentGateway: string | null;
  discountCodes: string[];
  note: string;
  sourceName: string | null;
  shippingCity: string | null;
  shippingProvince: string | null;
  shippingCountry: string | null;
  customerTags: string[];
  totalDiscount: string;
  subtotalPrice: string;
  totalTax: string;
  /** Phase 4 — the raw Shopify order JSON. See WebhookCustomEventPayload.rawPayload. */
  rawPayload?: Record<string, unknown>;
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
  /** Phase 4 — the raw Shopify fulfillment JSON. See WebhookCustomEventPayload.rawPayload. */
  rawPayload?: Record<string, unknown>;
}

/**
 * Lens-forwarded delivery exception events (NDR / NPR). The payload
 * carries the raw Clickpost scan as Lens received it — admin binds
 * phone + variables to arbitrary JSON paths at automation-rule time
 * via action.variable_bindings + action.recipient_phone_path. There
 * is NO pre-extraction here: Lens's payload shape is Clickpost's,
 * and the admin's binding rules handle the mapping.
 */
export interface LensExceptionEventPayload {
  name: 'lens.ndr' | 'lens.npr' | 'lens.rto';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  channelId: string;
  rawPayload?: Record<string, unknown>;
}

/**
 * Lens-forwarded Return Prime request events — created + refunded
 * split out as distinct typed events so the automation dropdown shows
 * them as first-class triggers (not under webhook.custom). Hoisted
 * fields are what admins typically branch on; everything else lives
 * on rawPayload for JSON-path binding at rule-authoring time.
 *
 * customerPhone comes from the top-level `customer.phone` key RP
 * sends in E.164 format (98.6% coverage per surma-ops's DB check).
 * refundMode is the first-line-item `refund.actual_mode` — real-world
 * distribution: pay_to_source 69%, razorpay_x 30%, remainder tiny.
 */
export interface ReturnPrimeRequestCreatedEventPayload {
  name: 'return_prime.request.created';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  customerEmail: string | null;
  channelId: string;
  /** `order.name` from RP — the Shopify order number ("#12345" style). */
  orderName: string | null;
  /** RP's internal return request id (Mongo ObjectId). */
  returnRequestId: string;
  /** Human-readable request number ("RET54895" / "EXC54384"), useful in templates. */
  requestNumber: string | null;
  /** "return" or "exchange" — RP uses one webhook topic for both. */
  requestType: string | null;
  rawPayload?: Record<string, unknown>;
}

export interface ReturnPrimeRequestRefundedEventPayload {
  name: 'return_prime.request.refunded';
  variables: Record<string, string | number | boolean>;
  customerPhone: string;
  customerEmail: string | null;
  channelId: string;
  orderName: string | null;
  returnRequestId: string;
  requestNumber: string | null;
  requestType: string | null;
  /** Refund amount in INR (string to preserve precision; RP sends decimal). */
  refundAmount: string | null;
  /**
   * `actual_mode` from the first refunded line item. Real values seen:
   *   pay_to_source | razorpay_x | shopflo | bank_transfer | others | store_credit
   * Null when RP's payload omits it. Admin's rule typically branches
   * razorpay_x (wallet refund) vs pay_to_source (back to original card).
   */
  refundMode: string | null;
  rawPayload?: Record<string, unknown>;
}

/**
 * Fires when a customer taps a QUICK_REPLY button on an outbound
 * template. Carries the admin-defined `button_id` (so rules can
 * filter on it) + the context that was stamped at send time (the
 * variables resolved from the triggering event — e.g. awb,
 * request_id, order_id). The context lives both inside
 * `rawPayload.ctx` for JSON-path binding AND flattened on the top
 * level for ergonomic predicate access.
 *
 * No ticket snapshot — the button tap doesn't mint a ticket (it's a
 * side-effect of a prior send). TicketSnapshot stays as a sentinel
 * so the discriminated union shape is consistent across events.
 */
export interface WhatsappButtonReplyEventPayload {
  name: 'whatsapp.button_reply';
  /** Admin-defined slug on the template button (e.g. "cancel_pickup"). */
  button_id: string;
  /** Visible button text as the customer saw it (e.g. "Cancel Pickup"). */
  button_text: string;
  /** wa_id of the customer who tapped. */
  customerPhone: string;
  /** Bridge channel that sent the original template. */
  channelId: string;
  /**
   * Resolved variables stamped at send time. Flattened onto the top
   * level of rawPayload (so JSON paths like `$.awb` work) alongside
   * the structural fields (`button_id`, `button_text`, phone, …).
   */
  rawPayload?: Record<string, unknown>;
}

export type AutomationEventPayload =
  | {
      event: typeof AUTOMATION_EVENT.TICKET_CREATED;
      ticket: TicketSnapshot;
      payload: TicketCreatedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.LENS_NDR;
      ticket: TicketSnapshot;
      payload: LensExceptionEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.LENS_NPR;
      ticket: TicketSnapshot;
      payload: LensExceptionEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.LENS_RTO;
      ticket: TicketSnapshot;
      payload: LensExceptionEventPayload;
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
    }
  | {
      event: typeof AUTOMATION_EVENT.SHOPIFY_ORDER_CANCELLED;
      ticket: TicketSnapshot;
      payload: ShopifyOrderCancelledEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_ORDER_SPLIT;
      ticket: TicketSnapshot;
      payload: ShopifyFulfillmentOrderSplitEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.WHATSAPP_BUTTON_REPLY;
      ticket: TicketSnapshot;
      payload: WhatsappButtonReplyEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.RETURN_PRIME_REQUEST_CREATED;
      ticket: TicketSnapshot;
      payload: ReturnPrimeRequestCreatedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.RETURN_PRIME_REQUEST_REFUNDED;
      ticket: TicketSnapshot;
      payload: ReturnPrimeRequestRefundedEventPayload;
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
