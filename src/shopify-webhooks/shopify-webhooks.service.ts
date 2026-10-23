import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { TicketStatus } from '../database/enums';
import { ShopifyWebhookEvent } from './entities/shopify-webhook-event.entity';

/**
 * Processes one Shopify webhook end-to-end.
 *
 *   1. INSERT into shopify_webhook_event (unique on webhook_id).
 *      A duplicate (23505) means Shopify retried after we 2xx'd —
 *      we skip emission and respond 200 again. This is the only
 *      idempotency check; it's atomic (the unique constraint) so no
 *      race window.
 *   2. Dispatch by topic. Today only `orders/create` has a mapping;
 *      unknown topics are persisted but no automation fires. This
 *      lets admins subscribe additional topics in Shopify without a
 *      Bridge deploy — the audit log picks up the raw payload, and
 *      Bridge can be taught to emit on them later.
 *
 * Emission is fire-and-forget via the automation engine; failures
 * inside rule evaluation can't 500 this request. The HTTP response
 * only signals "received + stored", not "rules executed".
 */
@Injectable()
export class ShopifyWebhooksService {
  private readonly logger = new Logger(ShopifyWebhooksService.name);

  constructor(
    @InjectRepository(ShopifyWebhookEvent)
    private readonly events: Repository<ShopifyWebhookEvent>,
    private readonly automations: AutomationEngine,
  ) {}

  async handle(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): Promise<{ deduped: boolean }> {
    // Insert first; dedup falls out of the UNIQUE constraint on
    // webhook_id. Catching 23505 ("unique_violation") → short-circuit.
    try {
      await this.events.save(
        this.events.create({
          webhook_id: input.webhookId,
          topic: input.topic,
          shop_domain: input.shopDomain,
          payload: input.payload,
        }),
      );
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const code = (err as unknown as { driverError?: { code?: string } })
          .driverError?.code;
        if (code === '23505') {
          this.logger.log(
            `shopify webhook dedup: webhook_id=${input.webhookId} already seen; skipping dispatch`,
          );
          return { deduped: true };
        }
      }
      throw err;
    }

    this.dispatchByTopic(input);
    return { deduped: false };
  }

  private dispatchByTopic(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): void {
    if (input.topic === 'orders/create') {
      this.emitOrderConfirmed(input);
      return;
    }
    if (input.topic === 'orders/fulfilled') {
      this.emitOrderFulfilled(input);
      return;
    }
    if (input.topic === 'fulfillments/create') {
      this.emitFulfillment(
        input,
        AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED,
        'shopify.fulfillment.created',
      );
      return;
    }
    if (input.topic === 'fulfillments/update') {
      this.emitFulfillment(
        input,
        AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED,
        'shopify.fulfillment.updated',
      );
      return;
    }
    // Unknown / not-yet-wired topic — audit row is already written;
    // nothing further to do. Admin can add handling later.
    this.logger.log(
      `shopify webhook: topic="${input.topic}" has no automation mapping yet; stored only`,
    );
  }

  private emitOrderConfirmed(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): void {
    const extracted = extractOrderFields(input.payload);
    if (!extracted) {
      this.logger.warn(
        `shopify order confirmed: webhook_id=${input.webhookId} missing required order fields; emitting skipped`,
      );
      return;
    }
    if (!extracted.customerPhone && !extracted.customerEmail) {
      // Pure gift / self-serve orders occasionally arrive with no
      // customer contact info. Nothing we could send to, so skip
      // the emit entirely. The audit row keeps the trail.
      this.logger.warn(
        `shopify order confirmed: webhook_id=${input.webhookId} order=${extracted.orderName} has no phone or email; emitting skipped`,
      );
      return;
    }

    this.automations.emit({
      event: AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED,
      // Sentinel ticket — channel-less event, same convention as
      // WEBHOOK_CUSTOM. Rule evaluator bypasses channel scoping when
      // channelType is null (see rule-evaluator.service.ts).
      ticket: {
        id: '',
        channelId: '',
        channelType: null,
        status: TicketStatus.OPEN,
        tags: [],
        assigneeId: null,
        teamId: '',
        subject: null,
      },
      payload: {
        name: 'shopify.order.confirmed',
        // channelId empty = handler uses the template's bound channel.
        channelId: '',
        customerPhone: extracted.customerPhone,
        customerEmail: extracted.customerEmail,
        orderName: extracted.orderName,
        orderNumber: extracted.orderNumber,
        orderTotal: extracted.orderTotal,
        currency: extracted.currency,
        itemCount: extracted.itemCount,
        shopDomain: input.shopDomain,
        // Named variables available to template variableMapping.
        // Admin binds `{{1}}` to e.g. `order_name` on the template
        // authoring UI; the resolver reads from this map.
        variables: {
          order_name: extracted.orderName,
          order_number: extracted.orderNumber,
          order_total: extracted.orderTotal,
          currency: extracted.currency,
          item_count: String(extracted.itemCount),
          customer_email: extracted.customerEmail ?? '',
        },
      },
    });
  }

  /** Most-recent received_at for the Integrations page's "last event". */
  async lastEventAt(shopDomain: string): Promise<Date | null> {
    const row = await this.events.findOne({
      where: { shop_domain: shopDomain },
      order: { received_at: 'DESC' },
      select: { received_at: true },
    });
    return row?.received_at ?? null;
  }

  /**
   * `orders/fulfilled` carries the full order payload, same shape as
   * orders/create. Reuses the order field extractor; only the event
   * name and the new `fulfillmentStatus` top-level field differ in
   * what we emit.
   */
  private emitOrderFulfilled(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): void {
    const extracted = extractOrderFields(input.payload);
    if (!extracted) {
      this.logger.warn(
        `shopify order fulfilled: webhook_id=${input.webhookId} missing required order fields; emitting skipped`,
      );
      return;
    }
    if (!extracted.customerPhone && !extracted.customerEmail) {
      this.logger.warn(
        `shopify order fulfilled: webhook_id=${input.webhookId} order=${extracted.orderName} has no phone or email; emitting skipped`,
      );
      return;
    }
    const fulfillmentStatus =
      asString(input.payload['fulfillment_status']) ?? 'fulfilled';
    this.automations.emit({
      event: AUTOMATION_EVENT.SHOPIFY_ORDER_FULFILLED,
      ticket: {
        id: '',
        channelId: '',
        channelType: null,
        status: TicketStatus.OPEN,
        tags: [],
        assigneeId: null,
        teamId: '',
        subject: null,
      },
      payload: {
        name: 'shopify.order.fulfilled',
        channelId: '',
        customerPhone: extracted.customerPhone,
        customerEmail: extracted.customerEmail,
        orderName: extracted.orderName,
        orderNumber: extracted.orderNumber,
        orderTotal: extracted.orderTotal,
        currency: extracted.currency,
        itemCount: extracted.itemCount,
        fulfillmentStatus,
        shopDomain: input.shopDomain,
        variables: {
          order_name: extracted.orderName,
          order_number: extracted.orderNumber,
          order_total: extracted.orderTotal,
          currency: extracted.currency,
          item_count: String(extracted.itemCount),
          fulfillment_status: fulfillmentStatus,
          customer_email: extracted.customerEmail ?? '',
        },
      },
    });
  }

  /**
   * `fulfillments/create` + `fulfillments/update` share the same
   * fulfillment payload shape. Caller passes the specific event name +
   * discriminator so the engine can route rules distinctly.
   */
  private emitFulfillment(
    input: {
      webhookId: string;
      topic: string;
      shopDomain: string;
      payload: Record<string, unknown>;
    },
    event:
      | typeof AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED
      | typeof AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED,
    name: 'shopify.fulfillment.created' | 'shopify.fulfillment.updated',
  ): void {
    const extracted = extractFulfillmentFields(input.payload);
    if (!extracted) {
      this.logger.warn(
        `shopify ${name}: webhook_id=${input.webhookId} missing required fulfillment fields; emitting skipped`,
      );
      return;
    }
    if (!extracted.customerPhone && !extracted.customerEmail) {
      this.logger.warn(
        `shopify ${name}: webhook_id=${input.webhookId} fulfillment=${extracted.fulfillmentId} has no phone or email on destination; emitting skipped`,
      );
      return;
    }
    this.automations.emit({
      event,
      ticket: {
        id: '',
        channelId: '',
        channelType: null,
        status: TicketStatus.OPEN,
        tags: [],
        assigneeId: null,
        teamId: '',
        subject: null,
      },
      payload: {
        name,
        channelId: '',
        customerPhone: extracted.customerPhone,
        customerEmail: extracted.customerEmail,
        orderId: extracted.orderId,
        orderName: extracted.orderName,
        fulfillmentId: extracted.fulfillmentId,
        status: extracted.status,
        shipmentStatus: extracted.shipmentStatus,
        trackingCompany: extracted.trackingCompany,
        trackingNumber: extracted.trackingNumber,
        trackingUrl: extracted.trackingUrl,
        shopDomain: input.shopDomain,
        variables: {
          order_id: extracted.orderId,
          order_name: extracted.orderName ?? '',
          fulfillment_id: extracted.fulfillmentId,
          status: extracted.status,
          shipment_status: extracted.shipmentStatus ?? '',
          tracking_company: extracted.trackingCompany ?? '',
          tracking_number: extracted.trackingNumber ?? '',
          tracking_url: extracted.trackingUrl ?? '',
          customer_email: extracted.customerEmail ?? '',
        },
      },
    });
  }

  /**
   * Chronological descending page for the Events inspector.
   * Keyset-paginated: pass the previous page's oldest `received_at`
   * as `before` to continue. Caller usually requests `limit + 1`
   * so it can tell whether a next page exists without a count query.
   */
  async listRecent(input: {
    before: Date | null;
    limit: number;
  }): Promise<ShopifyWebhookEvent[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .orderBy('e.received_at', 'DESC')
      .limit(input.limit);
    if (input.before) {
      qb.andWhere('e.received_at < :before', { before: input.before });
    }
    return qb.getMany();
  }
}

interface ExtractedOrderFields {
  orderName: string;
  orderNumber: string;
  orderTotal: string;
  currency: string;
  itemCount: number;
  customerPhone: string;
  customerEmail: string | null;
}

/**
 * Pull the fields we care about out of Shopify's order payload with
 * defensive typing. Shopify's payloads are stable but we treat them
 * as untrusted at the surface — a schema drift at Shopify's end
 * shouldn't crash the service. Any required field missing → return
 * null (caller skips emit, audit row still written).
 */
function extractOrderFields(
  payload: Record<string, unknown>,
): ExtractedOrderFields | null {
  // `name` is "#1234" with a configurable prefix; `order_number` is
  // the numeric id (e.g. 1234). Keep both.
  const orderName = asString(payload['name']);
  if (!orderName) return null;
  const orderNumber = asString(payload['order_number']) ?? '';
  const orderTotal = asString(payload['total_price']) ?? '0';
  const currency = asString(payload['currency']) ?? '';

  const lineItems = Array.isArray(payload['line_items'])
    ? (payload['line_items'] as Array<Record<string, unknown>>)
    : [];
  const itemCount = lineItems.reduce((sum, item) => {
    const q = Number(item['quantity']);
    return sum + (Number.isFinite(q) ? q : 0);
  }, 0);

  // Phone fallback chain mirrors Shopify's own hierarchy: customer
  // phone first (set in checkout), then shipping phone, then billing.
  // All get normalized to digits only — Meta's WhatsApp API accepts
  // E.164-ish wa_ids but is forgiving of leading `+`.
  const customer = payload['customer'] as Record<string, unknown> | undefined;
  const shipping = payload['shipping_address'] as
    | Record<string, unknown>
    | undefined;
  const billing = payload['billing_address'] as
    | Record<string, unknown>
    | undefined;
  const rawPhone =
    asString(customer?.['phone']) ??
    asString(shipping?.['phone']) ??
    asString(billing?.['phone']) ??
    asString(payload['phone']) ??
    null;
  const customerPhone = rawPhone ? rawPhone.replace(/\D/g, '') : '';

  const customerEmail =
    asString(customer?.['email']) ?? asString(payload['email']) ?? null;

  return {
    orderName,
    orderNumber,
    orderTotal,
    currency,
    itemCount,
    customerPhone,
    customerEmail,
  };
}

interface ExtractedFulfillmentFields {
  orderId: string;
  orderName: string | null;
  fulfillmentId: string;
  status: string;
  shipmentStatus: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  customerPhone: string;
  customerEmail: string | null;
}

/**
 * Extract from a Shopify fulfillment payload (fulfillments/create or
 * fulfillments/update — same shape). The customer-contact fields come
 * from the fulfillment's own `destination` block, which Shopify
 * populates from the shipping address at fulfillment time. If a
 * fulfillment has no destination (rare, pickup orders), phone + email
 * come out empty and the emit is skipped by the caller.
 *
 * `tracking_url` is Shopify's own normalised URL built from the
 * tracking_company + tracking_number pair; `tracking_urls` is the
 * array form on multi-item fulfillments. We prefer the array's first
 * entry when present so the template render has a clickable link
 * even when the single-field form is empty.
 */
function extractFulfillmentFields(
  payload: Record<string, unknown>,
): ExtractedFulfillmentFields | null {
  const fulfillmentId = asString(payload['id']);
  const orderIdRaw = payload['order_id'];
  const orderId =
    typeof orderIdRaw === 'number'
      ? String(orderIdRaw)
      : asString(orderIdRaw);
  if (!fulfillmentId || !orderId) return null;

  const orderName = asString(payload['name']); // Shopify stamps order name here on fulfillments
  const status = asString(payload['status']) ?? 'unknown';
  const shipmentStatus = asString(payload['shipment_status']);
  const trackingCompany = asString(payload['tracking_company']);
  const trackingNumber = asString(payload['tracking_number']);
  const trackingUrls = Array.isArray(payload['tracking_urls'])
    ? (payload['tracking_urls'] as unknown[])
    : [];
  const trackingUrl =
    asString(payload['tracking_url']) ??
    asString(trackingUrls[0]) ??
    null;

  const destination = payload['destination'] as
    | Record<string, unknown>
    | undefined;
  const rawPhone = asString(destination?.['phone']) ?? null;
  const customerPhone = rawPhone ? rawPhone.replace(/\D/g, '') : '';
  const customerEmail = asString(destination?.['email']) ?? null;

  return {
    orderId,
    orderName,
    fulfillmentId,
    status,
    shipmentStatus,
    trackingCompany,
    trackingNumber,
    trackingUrl,
    customerPhone,
    customerEmail,
  };
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
