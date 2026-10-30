import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import type { EnvVars } from '../config/env.validation';
import { TicketStatus } from '../database/enums';
import { ShopifyWebhookEvent } from './entities/shopify-webhook-event.entity';

/** Row shape returned by every webhook service's `topicStats()`. */
export interface TopicStatRow {
  topic: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

/** Cap on how long any surma-ops enrichment hop can delay webhook
 *  processing. Cache-hit: ~5ms. Shopify-live fetch: ~380-700ms worst
 *  case. 2s leaves headroom; we'd rather drop enrichment than block
 *  the webhook ACK or stall the handler. */
const LENS_FETCH_TIMEOUT_MS = 2000;

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
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async handle(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): Promise<{ deduped: boolean }> {
    // Enrich the raw payload BEFORE persistence so the stored row (and
    // the FE's event-sample JSON tree + the emitted automation event
    // payload) all see the same enriched shape. Mutates input.payload
    // in-place to add `enrichments.first_product_image_url` when the
    // product-image lookup succeeds. Silent no-op on failure — the
    // admin's rule's `header_image_fallback` kicks in at send time.
    if (input.topic === 'orders/create') {
      await this.enrichOrdersCreate(input);
    }

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
    if (input.topic === 'orders/cancelled') {
      this.emitOrderCancelled(input);
      return;
    }
    if (input.topic === 'fulfillment_orders/split') {
      this.emitFulfillmentOrderSplit(input);
      return;
    }
    if (input.topic === 'fulfillments/create') {
      this.emitFulfillment(
        input,
        AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED,
        'shopify.fulfillment.created',
      );
      // Fire-and-forget: the partial check calls surma-ops synchronously
      // then emits a second typed event IFF this is a mid-flight shipment
      // of a split order. Decoupled from the generic emit above so
      // admins can rely on fulfillment.created firing uniformly while
      // partially_fulfilled is a strict subset (split + not final).
      void this.maybeEmitPartiallyFulfilled(input).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `shopify partially_fulfilled check failed: webhook_id=${input.webhookId} err=${msg}`,
        );
      });
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
        tags: extracted.tags,
        financialStatus: extracted.financialStatus,
        fulfillmentStatus: extracted.fulfillmentStatus,
        paymentGateway: extracted.paymentGateway,
        discountCodes: extracted.discountCodes,
        note: extracted.note,
        sourceName: extracted.sourceName,
        shippingCity: extracted.shippingCity,
        shippingProvince: extracted.shippingProvince,
        shippingCountry: extracted.shippingCountry,
        customerTags: extracted.customerTags,
        totalDiscount: extracted.totalDiscount,
        subtotalPrice: extracted.subtotalPrice,
        totalTax: extracted.totalTax,
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
          financial_status: extracted.financialStatus ?? '',
          payment_gateway: extracted.paymentGateway ?? '',
          source_name: extracted.sourceName ?? '',
          shipping_city: extracted.shippingCity ?? '',
          shipping_province: extracted.shippingProvince ?? '',
          note: extracted.note,
          total_discount: extracted.totalDiscount,
          subtotal_price: extracted.subtotalPrice,
          discount_codes: extracted.discountCodes.join(', '),
          tags: extracted.tags.join(', '),
        },
        // Phase 4 — raw Shopify payload for rule-level variable_bindings
        // (admin picks arbitrary JSON paths in the automation editor).
        rawPayload: input.payload,
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
        tags: extracted.tags,
        financialStatus: extracted.financialStatus,
        paymentGateway: extracted.paymentGateway,
        discountCodes: extracted.discountCodes,
        note: extracted.note,
        sourceName: extracted.sourceName,
        shippingCity: extracted.shippingCity,
        shippingProvince: extracted.shippingProvince,
        shippingCountry: extracted.shippingCountry,
        customerTags: extracted.customerTags,
        totalDiscount: extracted.totalDiscount,
        subtotalPrice: extracted.subtotalPrice,
        totalTax: extracted.totalTax,
        variables: {
          order_name: extracted.orderName,
          order_number: extracted.orderNumber,
          order_total: extracted.orderTotal,
          currency: extracted.currency,
          item_count: String(extracted.itemCount),
          fulfillment_status: fulfillmentStatus,
          customer_email: extracted.customerEmail ?? '',
          financial_status: extracted.financialStatus ?? '',
          payment_gateway: extracted.paymentGateway ?? '',
          source_name: extracted.sourceName ?? '',
          shipping_city: extracted.shippingCity ?? '',
          shipping_province: extracted.shippingProvince ?? '',
          note: extracted.note,
          total_discount: extracted.totalDiscount,
          subtotal_price: extracted.subtotalPrice,
          discount_codes: extracted.discountCodes.join(', '),
          tags: extracted.tags.join(', '),
        },
        rawPayload: input.payload,
      },
    });
  }

  /**
   * `orders/cancelled` — same order payload shape as orders/create,
   * with `cancelled_at` + `cancel_reason` filled in. We hoist both to
   * top-level event fields so rules can filter on cancel_reason
   * ("inventory" vs "customer") without JSON-path dives.
   */
  private emitOrderCancelled(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): void {
    const extracted = extractOrderFields(input.payload);
    if (!extracted) {
      this.logger.warn(
        `shopify order cancelled: webhook_id=${input.webhookId} missing required order fields; emitting skipped`,
      );
      return;
    }
    if (!extracted.customerPhone && !extracted.customerEmail) {
      this.logger.warn(
        `shopify order cancelled: webhook_id=${input.webhookId} order=${extracted.orderName} has no phone or email; emitting skipped`,
      );
      return;
    }
    const cancelReason = asString(input.payload['cancel_reason']);
    const cancelledAt = asString(input.payload['cancelled_at']);
    this.automations.emit({
      event: AUTOMATION_EVENT.SHOPIFY_ORDER_CANCELLED,
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
        name: 'shopify.order.cancelled',
        channelId: '',
        customerPhone: extracted.customerPhone,
        customerEmail: extracted.customerEmail,
        orderName: extracted.orderName,
        orderNumber: extracted.orderNumber,
        orderTotal: extracted.orderTotal,
        currency: extracted.currency,
        itemCount: extracted.itemCount,
        shopDomain: input.shopDomain,
        tags: extracted.tags,
        financialStatus: extracted.financialStatus,
        fulfillmentStatus: extracted.fulfillmentStatus,
        paymentGateway: extracted.paymentGateway,
        discountCodes: extracted.discountCodes,
        note: extracted.note,
        sourceName: extracted.sourceName,
        shippingCity: extracted.shippingCity,
        shippingProvince: extracted.shippingProvince,
        shippingCountry: extracted.shippingCountry,
        customerTags: extracted.customerTags,
        totalDiscount: extracted.totalDiscount,
        subtotalPrice: extracted.subtotalPrice,
        totalTax: extracted.totalTax,
        cancelReason,
        cancelledAt,
        variables: {
          order_name: extracted.orderName,
          order_number: extracted.orderNumber,
          order_total: extracted.orderTotal,
          currency: extracted.currency,
          item_count: String(extracted.itemCount),
          customer_email: extracted.customerEmail ?? '',
          financial_status: extracted.financialStatus ?? '',
          payment_gateway: extracted.paymentGateway ?? '',
          source_name: extracted.sourceName ?? '',
          shipping_city: extracted.shippingCity ?? '',
          shipping_province: extracted.shippingProvince ?? '',
          note: extracted.note,
          total_discount: extracted.totalDiscount,
          subtotal_price: extracted.subtotalPrice,
          discount_codes: extracted.discountCodes.join(', '),
          tags: extracted.tags.join(', '),
          cancel_reason: cancelReason ?? '',
          cancelled_at: cancelledAt ?? '',
        },
        rawPayload: input.payload,
      },
    });
  }

  /**
   * `fulfillment_orders/split` — a pre-shipping signal. Shopify (or
   * the merchant via Admin) decided one planned fulfillment will go
   * out in multiple shipments. No AWB yet. Payload references
   * FulfillmentOrder ids + line items that moved; the customer phone
   * is NOT in this payload, so the automation rule's recipient_phone
   * binding has to come from the Shopify order sync table or an
   * enrichment hop.
   */
  private emitFulfillmentOrderSplit(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): void {
    const fo = input.payload['fulfillment_order'] as
      | Record<string, unknown>
      | undefined;
    const remaining = input.payload['remaining_fulfillment_order'] as
      | Record<string, unknown>
      | undefined;
    const replacement = input.payload['replacement_fulfillment_order'] as
      | Record<string, unknown>
      | undefined;
    const splitItems = Array.isArray(input.payload['split_line_items'])
      ? (input.payload['split_line_items'] as Array<Record<string, unknown>>)
      : [];
    const orderIdRaw = fo?.['order_id'];
    const orderId =
      typeof orderIdRaw === 'number'
        ? String(orderIdRaw)
        : (asString(orderIdRaw) ?? '');
    if (!orderId) {
      this.logger.warn(
        `shopify fulfillment_orders/split: webhook_id=${input.webhookId} missing fulfillment_order.order_id; emitting skipped`,
      );
      return;
    }
    const idOf = (v: Record<string, unknown> | undefined): string =>
      typeof v?.['id'] === 'number'
        ? String(v['id'])
        : (asString(v?.['id']) ?? '');
    const locationIdOf = (
      v: Record<string, unknown> | undefined,
    ): string | null => {
      const raw = v?.['assigned_location_id'];
      if (typeof raw === 'number') return String(raw);
      return asString(raw) ?? null;
    };
    const splitQuantity = splitItems.reduce((sum, it) => {
      const q = Number(it['quantity']);
      return sum + (Number.isFinite(q) ? q : 0);
    }, 0);
    this.automations.emit({
      event: AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_ORDER_SPLIT,
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
        name: 'shopify.fulfillment_order.split',
        channelId: '',
        // No customerPhone in the payload — automation rule binds it
        // via variable_bindings pulling from a Shopify order sync
        // table (surma-ops) or an enrichment step. Handler skips the
        // send with a warn log if recipient resolution yields empty.
        customerPhone: '',
        customerEmail: null,
        shopDomain: input.shopDomain,
        orderId,
        originalFulfillmentOrderId: idOf(fo),
        remainingFulfillmentOrderId: idOf(remaining),
        replacementFulfillmentOrderId: idOf(replacement),
        originalLocationId: locationIdOf(fo),
        replacementLocationId: locationIdOf(replacement),
        splitItemCount: splitItems.length,
        splitQuantity,
        variables: {
          order_id: orderId,
          split_item_count: String(splitItems.length),
          split_quantity: String(splitQuantity),
          original_fulfillment_order_id: idOf(fo),
          replacement_fulfillment_order_id: idOf(replacement),
        },
        rawPayload: input.payload,
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
        rawPayload: input.payload,
      },
    });
  }

  /**
   * Per-topic stats within a sliding window. Powers the Integrations
   * page's expanded card so admins can see "we received N events of
   * topic X in the last K days". Ordered by count descending so the
   * noisiest topic surfaces first.
   */
  async topicStats(input: { since: Date }): Promise<TopicStatRow[]> {
    const rows = (await this.events
      .createQueryBuilder('e')
      .select('e.topic', 'topic')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('MIN(e.received_at)', 'first_at')
      .addSelect('MAX(e.received_at)', 'last_at')
      .where('e.received_at >= :since', { since: input.since })
      .groupBy('e.topic')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany()) as Array<{
      topic: string;
      count: number;
      first_at: Date;
      last_at: Date;
    }>;
    return rows.map((r) => ({
      topic: r.topic,
      count: r.count,
      firstAt: r.first_at.toISOString(),
      lastAt: r.last_at.toISOString(),
    }));
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

  /**
   * On `fulfillments/create`, ask surma-ops whether this shipment is
   * a mid-flight piece of a split order and (iff so) emit the typed
   * SHOPIFY_ORDER_PARTIALLY_FULFILLED event. Surma-ops is the oracle
   * because the `Split_shipment` tag isn't on the order at
   * orders/create time (0.5% coverage) and the fulfillment payload
   * itself carries no order-level fields.
   *
   * Fully best-effort: on any failure (secret unset, 404 from
   * surma-ops meaning order not yet synced OR fulfillment not yet
   * visible, 5xx, timeout) we log at `warn` and skip the emit. The
   * generic shopify.fulfillment.created event has already fired by
   * the time this runs, so admins who want "any shipment" rules
   * aren't blocked by surma-ops downtime.
   */
  private async maybeEmitPartiallyFulfilled(input: {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const secret = this.config.get('LENS_INTERNAL_SECRET', { infer: true });
    if (!secret) return;
    const extracted = extractFulfillmentFields(input.payload);
    if (!extracted) return;
    // Fulfillment `name` is "#251229.1" / "#251229.2" / etc. The order
    // name is everything before the ".<n>" suffix, stripped of the
    // leading "#" (surma-ops indexes by bare number, per contract).
    const orderName = extractOrderNameFromFulfillmentName(extracted.orderName);
    if (!orderName) {
      this.logger.log(
        `shopify partially_fulfilled: webhook_id=${input.webhookId} could not derive order name from fulfillment name=${extracted.orderName ?? 'null'} — skipping`,
      );
      return;
    }
    if (!extracted.customerPhone && !extracted.customerEmail) {
      // Same guard as the generic emit — nothing to deliver to.
      return;
    }
    const baseUrl = this.config.get('LENS_FULFILLMENT_CONTEXT_URL', {
      infer: true,
    });
    if (!baseUrl) {
      // Env var not set in this deployment — feature off. Admins can
      // still rely on shopify.fulfillment.created / shopify.order.fulfilled.
      return;
    }
    const url =
      `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(orderName)}` +
      `/fulfillment-context?fulfillment_id=${encodeURIComponent(extracted.fulfillmentId)}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), LENS_FETCH_TIMEOUT_MS);
    let context: FulfillmentContext | null = null;
    try {
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': secret },
        signal: ac.signal,
      });
      if (res.status === 404) {
        this.logger.log(
          `shopify partially_fulfilled: webhook_id=${input.webhookId} order=${orderName} fulfillment=${extracted.fulfillmentId} not yet visible in surma-ops — skipping`,
        );
        return;
      }
      if (!res.ok) {
        this.logger.warn(
          `shopify partially_fulfilled: webhook_id=${input.webhookId} order=${orderName} context lookup returned ${res.status} — skipping`,
        );
        return;
      }
      context = (await res.json()) as FulfillmentContext;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `shopify partially_fulfilled: webhook_id=${input.webhookId} order=${orderName} context lookup failed: ${msg} — skipping`,
      );
      return;
    } finally {
      clearTimeout(t);
    }
    if (!context) return;
    // Gate: only emit when this is a MID-FLIGHT shipment of a split
    // order. Single-shipment orders and the final shipment of a split
    // order are covered by shopify.order.fulfilled.
    if (!context.is_split_order || context.is_final_fulfillment) {
      this.logger.log(
        `shopify partially_fulfilled: webhook_id=${input.webhookId} order=${orderName} is_split=${context.is_split_order} is_final=${context.is_final_fulfillment} — skipping emit`,
      );
      return;
    }
    this.logger.log(
      `shopify partially_fulfilled: webhook_id=${input.webhookId} order=${orderName} shipment ${context.fulfillment_number} of split order (so-far=${context.total_fulfillments_so_far}) — emitting`,
    );
    this.automations.emit({
      event: AUTOMATION_EVENT.SHOPIFY_ORDER_PARTIALLY_FULFILLED,
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
        name: 'shopify.order.partially_fulfilled',
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
        fulfillmentNumber: context.fulfillment_number,
        totalFulfillmentsSoFar: context.total_fulfillments_so_far,
        orderTags: Array.isArray(context.order_tags)
          ? context.order_tags
          : [],
        variables: {
          order_id: extracted.orderId,
          order_name: extracted.orderName ?? '',
          fulfillment_id: extracted.fulfillmentId,
          fulfillment_number: String(context.fulfillment_number),
          total_fulfillments_so_far: String(context.total_fulfillments_so_far),
          status: extracted.status,
          shipment_status: extracted.shipmentStatus ?? '',
          tracking_company: extracted.trackingCompany ?? '',
          tracking_number: extracted.trackingNumber ?? '',
          tracking_url: extracted.trackingUrl ?? '',
          customer_email: extracted.customerEmail ?? '',
        },
        rawPayload: input.payload,
      },
    });
  }

  /**
   * Resolve the first line item's product image via surma-ops's
   * cache endpoint (loopback, same box). Mutates input.payload in
   * place to add `enrichments.first_product_image_url` on success.
   *
   * Fully best-effort: on any failure (secret unset, SKU 404,
   * surma-ops down, 2s timeout) we log at `log` level and move on
   * without touching the payload. The admin's automation rule's
   * `header_image_fallback` URL kicks in at send time so the
   * template still fires with a sensible default image.
   *
   * See the surma-ops contract committed on 2026-10-28:
   *   GET http://127.0.0.1:3000/api/products/image?sku=<SKU>
   *   Header X-Internal-Secret: <same value as surma-ops env>
   *   200 { sku, image_url, fetched_at, source: "cache" | "shopify_live" }
   *   404 (unknown SKU) / 502 (missing product_id or Shopify failure)
   */
  private async enrichOrdersCreate(input: {
    webhookId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    // Local-only aggregations first — these don't need a network hop
    // and are useful even when surma-ops is unreachable. Picks the
    // human-readable line_items[].name (e.g. "Salt & Pepper Top in
    // Black - L") because templates typically read like:
    //   "Product: {{products}}, Amount: ₹{{order_total}}"
    // Also exposes a count so admins can conditionally say
    // "your product" vs "your 2 products" via automation predicate.
    const items = input.payload['line_items'];
    if (Array.isArray(items) && items.length > 0) {
      const names: string[] = [];
      const titles: string[] = [];
      for (const it of items) {
        if (it && typeof it === 'object') {
          const n = (it as Record<string, unknown>)['name'];
          const t = (it as Record<string, unknown>)['title'];
          if (typeof n === 'string' && n.trim()) names.push(n.trim());
          if (typeof t === 'string' && t.trim()) titles.push(t.trim());
        }
      }
      if (names.length > 0 || titles.length > 0) {
        const existing =
          (input.payload['enrichments'] as
            | Record<string, unknown>
            | undefined) ?? {};
        if (names.length > 0) existing['product_names'] = names.join(', ');
        if (titles.length > 0) existing['product_titles'] = titles.join(', ');
        existing['product_count'] = items.length;
        input.payload['enrichments'] = existing;
      }
    }

    // Remote hop — first-product image URL via surma-ops cache. Best-
    // effort; on failure the automation rule's header_image_fallback
    // kicks in at send time. See 2026-10-28 contract committed in
    // bridge-be #8408a4f + surma-ops side.
    const secret = this.config.get('LENS_INTERNAL_SECRET', { infer: true });
    const baseUrl = this.config.get('LENS_PRODUCT_IMAGE_URL', { infer: true });
    if (!secret || !baseUrl) return;
    const sku = extractFirstLineItemSku(input.payload);
    if (!sku) {
      this.logger.log(
        `shopify order confirmed: webhook_id=${input.webhookId} no first-line-item SKU — skipping image enrichment`,
      );
      return;
    }
    const url = `${baseUrl.replace(/\/$/, '')}?sku=${encodeURIComponent(sku)}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), LENS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': secret },
        signal: ac.signal,
      });
      if (!res.ok) {
        this.logger.log(
          `shopify order confirmed: webhook_id=${input.webhookId} sku=${sku} image lookup returned ${res.status} — falling back`,
        );
        return;
      }
      const body = (await res.json()) as {
        image_url?: string;
        source?: string;
      };
      if (!body.image_url) return;
      const existing =
        (input.payload['enrichments'] as Record<string, unknown> | undefined) ??
        {};
      existing['first_product_image_url'] = body.image_url;
      existing['first_product_image_source'] = body.source ?? 'unknown';
      input.payload['enrichments'] = existing;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log(
        `shopify order confirmed: webhook_id=${input.webhookId} sku=${sku} image lookup failed: ${msg} — falling back`,
      );
    } finally {
      clearTimeout(t);
    }
  }
}

/** First SKU in line_items[], or null if none. */
function extractFirstLineItemSku(
  payload: Record<string, unknown>,
): string | null {
  const items = payload['line_items'];
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const sku = first['sku'];
  if (typeof sku !== 'string' || sku.trim().length === 0) return null;
  return sku.trim();
}

interface ExtractedOrderFields {
  orderName: string;
  orderNumber: string;
  orderTotal: string;
  currency: string;
  itemCount: number;
  customerPhone: string;
  customerEmail: string | null;
  /**
   * Shopify stores tags as a single comma-separated string on the
   * order ("vip, repeat, rewind_exchange"). We split + trim + drop
   * empties here so predicates can match on exact tag strings via
   * the `in` / `contains` operators on an array. Mirrors the shape
   * the ticket's own tags[] field uses so rule authoring stays
   * consistent across event sources.
   */
  tags: string[];
  /** paid / pending / partially_refunded / refunded / voided / authorized. */
  financialStatus: string | null;
  /** null / partial / fulfilled / restocked. Null = unfulfilled. */
  fulfillmentStatus: string | null;
  /**
   * Admin-facing payment gateway name. Shopify exposes two shapes —
   * `gateway` (single string, legacy) and `payment_gateway_names` (array,
   * newer). We pick array[0] falling back to the string so a predicate
   * "gateway equals cash_on_delivery" works for COD flows.
   */
  paymentGateway: string | null;
  /** Comma-joined list of applied discount codes ("SALE10, STUDENT"). */
  discountCodes: string[];
  /** Customer-entered note at checkout. "" when absent. */
  note: string;
  /** web / pos / mobile_app / instagram / shop_app — admins route on this. */
  sourceName: string | null;
  shippingCity: string | null;
  shippingProvince: string | null;
  shippingCountry: string | null;
  /** Customer-level tags (loyalty / VIP flags). Comma-split like order tags. */
  customerTags: string[];
  /** Total discount amount (string to preserve precision — Shopify's shape). */
  totalDiscount: string;
  subtotalPrice: string;
  totalTax: string;
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

  const splitCsv = (raw: string | null): string[] =>
    raw
      ? raw
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];
  const tags = splitCsv(asString(payload['tags']));
  const customerTags = splitCsv(asString(customer?.['tags']));

  const financialStatus = asString(payload['financial_status']);
  const fulfillmentStatus = asString(payload['fulfillment_status']);
  const sourceName = asString(payload['source_name']);
  const note = asString(payload['note']) ?? '';
  const totalDiscount = asString(payload['total_discounts']) ?? '0';
  const subtotalPrice = asString(payload['subtotal_price']) ?? '0';
  const totalTax = asString(payload['total_tax']) ?? '0';

  const gatewayNames = Array.isArray(payload['payment_gateway_names'])
    ? (payload['payment_gateway_names'] as unknown[])
        .map((g) => (typeof g === 'string' ? g : null))
        .filter((g): g is string => !!g)
    : [];
  const paymentGateway =
    gatewayNames[0] ?? asString(payload['gateway']) ?? null;

  const discountEntries = Array.isArray(payload['discount_codes'])
    ? (payload['discount_codes'] as Array<Record<string, unknown>>)
    : [];
  const discountCodes = discountEntries
    .map((d) => asString(d['code']))
    .filter((d): d is string => !!d);

  const shippingCity = asString(shipping?.['city']) ?? null;
  const shippingProvince = asString(shipping?.['province']) ?? null;
  const shippingCountry = asString(shipping?.['country']) ?? null;

  return {
    orderName,
    orderNumber,
    orderTotal,
    currency,
    itemCount,
    customerPhone,
    customerEmail,
    tags,
    financialStatus,
    fulfillmentStatus,
    paymentGateway,
    discountCodes,
    note,
    sourceName,
    shippingCity,
    shippingProvince,
    shippingCountry,
    customerTags,
    totalDiscount,
    subtotalPrice,
    totalTax,
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

/**
 * surma-ops's fulfillment-context endpoint response shape. Contract
 * committed 2026-10-30 — see LENS_FULFILLMENT_CONTEXT_URL_BASE doc.
 */
interface FulfillmentContext {
  is_split_order: boolean;
  is_final_fulfillment: boolean;
  fulfillment_number: number;
  total_fulfillments_so_far: number;
  order_tags: string[];
  order_name: string;
}

/**
 * Fulfillment `name` is "#251229.1" / "#251229.2" / etc. Strip the
 * trailing ".<digits>" suffix and the leading "#" to recover the
 * bare order name surma-ops indexes by (per contract).
 */
function extractOrderNameFromFulfillmentName(
  fulfillmentName: string | null,
): string | null {
  if (!fulfillmentName) return null;
  const trimmed = fulfillmentName.trim();
  const noSuffix = trimmed.replace(/\.\d+$/, '');
  const bare = noSuffix.replace(/^#/, '').trim();
  return bare.length > 0 ? bare : null;
}
