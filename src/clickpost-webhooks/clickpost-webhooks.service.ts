import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import type { EnvVars } from '../config/env.validation';
import { TicketStatus } from '../database/enums';
import { ClickpostWebhookEvent } from './entities/clickpost-webhook-event.entity';
import type { TopicStatRow } from '../shopify-webhooks/shopify-webhooks.service';

/** Cap on the surma-ops enrichment hop. Cache-hit is ~5ms per
 *  surma-ops's 2026-10-30 measurement; 2s leaves plenty of headroom
 *  to drop enrichment rather than block the webhook ACK. */
const SURMA_OPS_CONTACT_FETCH_TIMEOUT_MS = 2000;

/**
 * Receives + persists Clickpost tracking webhooks. No field extraction
 * or automation emission yet — scoping scaffolding so we can observe
 * real OFD / Delivered payloads in the Events inspector before writing
 * extractors. Clickpost's status taxonomy is wide and dependent on the
 * admin's selected-checkpoints choice; guessing fields leads to
 * brittle code.
 *
 * Idempotency: Clickpost retries on non-200 and doesn't send a
 * dedicated event id. We derive one from
 *   (waybill + clickpost_status_code + timestamp)
 * which is unique per shipment per status per scan. Falls back to a
 * sha256 of the raw body when any of those are absent. UNIQUE on
 * webhook_id catches retries at insert time; no race window.
 */
@Injectable()
export class ClickpostWebhooksService {
  private readonly logger = new Logger(ClickpostWebhooksService.name);

  constructor(
    @InjectRepository(ClickpostWebhookEvent)
    private readonly events: Repository<ClickpostWebhookEvent>,
    private readonly config: ConfigService<EnvVars, true>,
    @Inject(forwardRef(() => AutomationEngine))
    private readonly automations: AutomationEngine,
  ) {}

  async handle(payload: Record<string, unknown>): Promise<{ deduped: boolean }> {
    const webhookId = this.deriveWebhookId(payload);
    // Un-mask the Clickpost PII BEFORE persistence so the stored row,
    // the FE event-sample JSON tree, and any downstream automation
    // event all see the same enriched shape. Clickpost's enterprise
    // plan redacts customer phone / email / name to "**********" with
    // no toggle; surma-ops has the real contact on the parent Shopify
    // order. Mutates payload in-place; silent no-op on any failure.
    await this.enrichMaskedContact(payload, webhookId);
    // Pure derivation from the just-received payload — adds a clean
    // carrier brand under enrichments.courier_brand so the Events
    // inspector + template authoring UI's JSON tree see it, and the
    // emit() hoist below picks it up from the same spot. Separate from
    // enrichMaskedContact because this doesn't hit surma-ops.
    this.normaliseCourierPartner(payload);
    const rawStatus = asString(payload['status']) ?? 'unknown';
    const waybill = asString(payload['waybill']);
    const additional = payload['additional'] as
      | Record<string, unknown>
      | undefined;
    const orderId = asString(additional?.['order_id']);
    // Normalise the status from the (latest_status.clickpost_status_code,
    // latest_status.clickpost_status_bucket, additional.is_rvp) triple.
    // The raw `status` field Clickpost ships is wildly inconsistent for
    // the same semantic event — e.g. a real customer delivery
    // (code=8 bucket=6 is_rvp=false) can arrive with raw strings like
    // "Delivered", "SHIPMENT DELIVERED", "DTO", "Out For Delivery",
    // "Received at Forward Hub", or random digits. Automation rules
    // that key off the raw string break; normalising at ingest gives
    // admins stable, meaningful event names to trigger on.
    //
    // Payload stays untouched (audit integrity) — only the DB `status`
    // column reflects the normalised name. Any (code, bucket, is_rvp)
    // triple not in the registry falls through to the raw status.
    const normalisedStatus = normaliseClickpostStatus(payload) ?? rawStatus;
    // Read phone AFTER enrichMaskedContact — Clickpost's raw payload
    // ships "**********" there; surma-ops's lookup overwrites with the
    // real value when found. If the lookup failed (order not synced
    // yet, 5xx, etc.), the mask stays and we persist null.
    const rawPhone = asString(additional?.['phone']);
    const customerPhone =
      rawPhone && !rawPhone.includes('*')
        ? rawPhone.replace(/\D/g, '') || null
        : null;
    try {
      await this.events.save(
        this.events.create({
          webhook_id: webhookId,
          status: normalisedStatus,
          waybill,
          order_id: orderId,
          payload,
          customer_phone: customerPhone,
        }),
      );
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const code = (err as unknown as { driverError?: { code?: string } })
          .driverError?.code;
        if (code === '23505') {
          this.logger.log(
            `clickpost webhook dedup: webhook_id=${webhookId} already seen; skipping`,
          );
          return { deduped: true };
        }
      }
      throw err;
    }
    this.logger.log(
      `clickpost webhook received: status="${normalisedStatus}" (raw="${rawStatus}") waybill=${waybill ?? 'null'} order=${orderId ?? 'null'}`,
    );
    this.emit(normalisedStatus, payload, customerPhone, orderId, waybill);
    return { deduped: false };
  }

  /**
   * Fan a persisted Clickpost webhook out as a typed automation event
   * when the normalised status matches a known trigger. Admin's rule
   * then triggers on `clickpost.order_delivered` or
   * `clickpost.return_delivered` directly (no filtering on a raw
   * status string). Unknown statuses stay inert — stored for audit,
   * but no automation emit.
   *
   * Emission runs ONLY after the dedup insert succeeds, so a Clickpost
   * retry (same webhook_id) never re-emits.
   */
  private emit(
    normalisedStatus: string,
    payload: Record<string, unknown>,
    customerPhone: string | null,
    orderId: string | null,
    waybill: string | null,
  ): void {
    let event:
      | typeof AUTOMATION_EVENT.CLICKPOST_ORDER_DELIVERED
      | typeof AUTOMATION_EVENT.CLICKPOST_RETURN_DELIVERED
      | typeof AUTOMATION_EVENT.CLICKPOST_OUT_FOR_DELIVERY_CUSTOMER
      | typeof AUTOMATION_EVENT.CLICKPOST_OUT_FOR_DELIVERY_WAREHOUSE
      | typeof AUTOMATION_EVENT.CLICKPOST_OUT_FOR_PICKUP_FROM_WAREHOUSE
      | typeof AUTOMATION_EVENT.CLICKPOST_OUT_FOR_PICKUP_FROM_CUSTOMER
      | typeof AUTOMATION_EVENT.CLICKPOST_PICKED_UP_FROM_WAREHOUSE
      | typeof AUTOMATION_EVENT.CLICKPOST_PICKED_UP_FROM_CUSTOMER;
    let name:
      | 'clickpost.order_delivered'
      | 'clickpost.return_delivered'
      | 'clickpost.out_for_delivery_customer'
      | 'clickpost.out_for_delivery_warehouse'
      | 'clickpost.out_for_pickup_from_warehouse'
      | 'clickpost.out_for_pickup_from_customer'
      | 'clickpost.picked_up_from_warehouse'
      | 'clickpost.picked_up_from_customer';
    if (normalisedStatus === 'Surma Order Delivered To Customer') {
      event = AUTOMATION_EVENT.CLICKPOST_ORDER_DELIVERED;
      name = 'clickpost.order_delivered';
    } else if (normalisedStatus === 'Surma Return Delivered To Warehouse') {
      event = AUTOMATION_EVENT.CLICKPOST_RETURN_DELIVERED;
      name = 'clickpost.return_delivered';
    } else if (normalisedStatus === 'Surma Out For Delivery To Customer') {
      event = AUTOMATION_EVENT.CLICKPOST_OUT_FOR_DELIVERY_CUSTOMER;
      name = 'clickpost.out_for_delivery_customer';
    } else if (normalisedStatus === 'Surma Out For Delivery To Warehouse') {
      event = AUTOMATION_EVENT.CLICKPOST_OUT_FOR_DELIVERY_WAREHOUSE;
      name = 'clickpost.out_for_delivery_warehouse';
    } else if (normalisedStatus === 'Surma Out For Pickup From Warehouse') {
      event = AUTOMATION_EVENT.CLICKPOST_OUT_FOR_PICKUP_FROM_WAREHOUSE;
      name = 'clickpost.out_for_pickup_from_warehouse';
    } else if (normalisedStatus === 'Surma Out For Pickup From Customer') {
      event = AUTOMATION_EVENT.CLICKPOST_OUT_FOR_PICKUP_FROM_CUSTOMER;
      name = 'clickpost.out_for_pickup_from_customer';
    } else if (normalisedStatus === 'Surma Picked Up From Warehouse') {
      event = AUTOMATION_EVENT.CLICKPOST_PICKED_UP_FROM_WAREHOUSE;
      name = 'clickpost.picked_up_from_warehouse';
    } else if (normalisedStatus === 'Surma Picked Up From Customer') {
      event = AUTOMATION_EVENT.CLICKPOST_PICKED_UP_FROM_CUSTOMER;
      name = 'clickpost.picked_up_from_customer';
    } else {
      // Not a status we've chosen to emit as a typed event. Still
      // stored + visible in the Events inspector; admin can trigger
      // on it later once we add a typed emission here.
      return;
    }
    if (!customerPhone) {
      this.logger.warn(
        `clickpost ${name}: no customer phone resolved; emitting with empty phone — admin's rule will skip the send`,
      );
    }
    const additional = payload['additional'] as
      | Record<string, unknown>
      | undefined;
    const trackingUrl =
      additional &&
      typeof additional['trackingUrl'] === 'object' &&
      additional['trackingUrl'] !== null
        ? asString(
            (additional['trackingUrl'] as Record<string, unknown>)['url'],
          )
        : null;
    const courierPartner = asString(payload['account_code']);
    // Normalised brand lives on enrichments.courier_brand (stamped at
    // ingest). Hoist to top-level so admin rules + template bindings
    // can read `event.normalisedCourierPartnerName` without diving into
    // rawPayload. Null when the courier isn't in the brand registry.
    const normalisedCourierPartnerName = asString(
      (payload['enrichments'] as Record<string, unknown> | undefined)?.[
        'courier_brand'
      ],
    );
    // Order-level fields were stamped on payload.enrichments.order_info
    // by enrichMaskedContact when surma-ops's /customer-contact
    // returned 200. Pick them up and hoist to typed event payload so
    // admin rules can filter on event.paymentMode etc. without diving
    // into rawPayload.
    const orderInfo =
      (payload['enrichments'] as Record<string, unknown> | undefined)?.[
        'order_info'
      ] as Record<string, unknown> | undefined;
    const paymentMode = (orderInfo?.['payment_mode'] as 'COD' | 'PREPAID' | null) ?? null;
    const codAmount = asString(orderInfo?.['cod_amount']);
    const orderTotal = asString(orderInfo?.['order_total']);
    const financialStatus = asString(orderInfo?.['financial_status']);
    const orderTags = Array.isArray(orderInfo?.['order_tags'])
      ? (orderInfo?.['order_tags'] as string[])
      : [];
    const currency = asString(orderInfo?.['currency']);
    // `products` arrives as a pre-formatted comma-joined string from
    // surma-ops (scoped to this waybill's fulfillment). Empty string ""
    // means waybill didn't match any fulfillment — kept as "" rather
    // than coerced to null so templates can render it without a
    // conditional (admin binding `{{products}}` just prints blank). Null
    // only when the enrichment hop failed entirely.
    const rawProducts = orderInfo?.['products'];
    const products =
      typeof rawProducts === 'string' ? rawProducts : null;
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
        customerPhone: customerPhone ?? '',
        orderName: orderId,
        waybill,
        trackingUrl,
        courierPartner,
        normalisedCourierPartnerName,
        paymentMode,
        codAmount,
        orderTotal,
        financialStatus,
        orderTags,
        currency,
        products,
        variables: {
          order_id: orderId ?? '',
          waybill: waybill ?? '',
          tracking_url: trackingUrl ?? '',
          courier_partner: courierPartner ?? '',
          normalised_courier_partner_name: normalisedCourierPartnerName ?? '',
          payment_mode: paymentMode ?? '',
          cod_amount: codAmount ?? '',
          order_total: orderTotal ?? '',
          financial_status: financialStatus ?? '',
          order_tags: orderTags.join(', '),
          currency: currency ?? '',
          products: products ?? '',
        },
        rawPayload: payload,
      },
    });
  }

  /** Most-recent received_at for the Integrations page's "last event". */
  async lastEventAt(): Promise<Date | null> {
    const row = await this.events.findOne({
      where: {},
      order: { received_at: 'DESC' },
      select: { received_at: true },
    });
    return row?.received_at ?? null;
  }

  /**
   * Per-status stats within a sliding window. Clickpost uses `status`
   * as the natural event-type (OFD / Delivered / etc.) — same role as
   * `topic` on other platforms.
   */
  async topicStats(input: { since: Date }): Promise<TopicStatRow[]> {
    const rows = (await this.events
      .createQueryBuilder('e')
      .select('e.status', 'topic')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('MIN(e.received_at)', 'first_at')
      .addSelect('MAX(e.received_at)', 'last_at')
      .where('e.received_at >= :since', { since: input.since })
      .groupBy('e.status')
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

  async listRecent(input: {
    before: Date | null;
    limit: number;
    phone?: string | null;
    /** Clickpost uses `status` as its topic surface (OFD, Delivered, …). */
    topic?: string | null;
  }): Promise<ClickpostWebhookEvent[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .orderBy('e.received_at', 'DESC')
      .limit(input.limit);
    if (input.before) {
      qb.andWhere('e.received_at < :before', { before: input.before });
    }
    if (input.phone && input.phone.trim().length > 0) {
      qb.andWhere('e.customer_phone ILIKE :phone', {
        phone: `%${input.phone.trim()}%`,
      });
    }
    if (input.topic && input.topic.trim().length > 0) {
      qb.andWhere('e.status ILIKE :topic', {
        topic: `%${input.topic.trim()}%`,
      });
    }
    return qb.getMany();
  }

  /**
   * Look up the real customer contact for this Clickpost webhook via
   * surma-ops and overwrite the masked fields in-place. Payload shape
   * before (from Clickpost):
   *   additional: { phone: "**********", email: "**********", name: "**********", order_id: "242084", … }
   * Payload shape after a successful lookup:
   *   additional: { phone: "919821697002", email: "payal@…", name: "Payal thakkar", order_id: "242084", … }
   *   enrichments: { contact_source: "surma_ops_lookup" }
   *
   * Fully best-effort. On any failure (env unset, secret missing, no
   * order_id in payload, surma-ops 404 / 5xx / timeout, malformed
   * response) we leave the masks in place and move on. The admin's
   * automation rule will see the empty phone and skip; same cost as
   * doing nothing.
   */
  private async enrichMaskedContact(
    payload: Record<string, unknown>,
    webhookId: string,
  ): Promise<void> {
    const baseUrl = this.config.get('LENS_CUSTOMER_CONTACT_URL', {
      infer: true,
    });
    const secret = this.config.get('LENS_INTERNAL_SECRET', { infer: true });
    if (!baseUrl || !secret) return;
    const additional = payload['additional'] as
      | Record<string, unknown>
      | undefined;
    if (!additional) return;
    const orderId = asString(additional['order_id']);
    if (!orderId) {
      this.logger.log(
        `clickpost enrich: webhook_id=${webhookId} no additional.order_id — skipping`,
      );
      return;
    }
    // Pass the Clickpost waybill as a query param so surma-ops can scope
    // `products` to THIS shipment's fulfillment (vs the full-order
    // fallback). Split-order deliveries would otherwise send
    // "Pants + Co-Ord Set out for delivery" when only the pants are in
    // THIS box. When waybill is absent (shouldn't happen on real
    // Clickpost webhooks but defensive), surma-ops falls back to all
    // order items — backward-compatible by design.
    const waybill = asString(payload['waybill']);
    const url =
      `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(orderId)}` +
      `/customer-contact` +
      (waybill ? `?waybill=${encodeURIComponent(waybill)}` : '');
    const ac = new AbortController();
    const t = setTimeout(
      () => ac.abort(),
      SURMA_OPS_CONTACT_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': secret },
        signal: ac.signal,
      });
      if (res.status === 404) {
        this.logger.log(
          `clickpost enrich: webhook_id=${webhookId} order=${orderId} not found in surma-ops — leaving masks in place`,
        );
        return;
      }
      if (!res.ok) {
        this.logger.warn(
          `clickpost enrich: webhook_id=${webhookId} order=${orderId} returned ${res.status} — leaving masks`,
        );
        return;
      }
      const body = (await res.json()) as {
        customer_phone?: string | null;
        customer_email?: string | null;
        customer_first_name?: string | null;
        customer_last_name?: string | null;
        payment_mode?: 'COD' | 'PREPAID' | null;
        cod_amount?: string | null;
        order_total?: string | null;
        financial_status?: string | null;
        order_tags?: string[] | null;
        currency?: string | null;
        /**
         * Comma-joined human-readable product list scoped to the
         * waybill's fulfillment when waybill was passed. "" when the
         * waybill didn't match any fulfillment (AWB drift between
         * Clickpost + Shopify). Full-order items when waybill wasn't
         * passed (not possible for Clickpost webhooks today — we always
         * pass it).
         */
        products?: string | null;
      };
      // Overwrite ONLY the fields surma-ops actually returned a value
      // for — a null phone (COD-manual order without captured phone)
      // leaves the "**********" mask in place rather than wiping it,
      // which keeps the shape distinguishable from "we never tried
      // enrichment" (where enrichments.contact_source wouldn't be set).
      if (body.customer_phone) additional['phone'] = body.customer_phone;
      if (body.customer_email) additional['email'] = body.customer_email;
      const fullName = [body.customer_first_name, body.customer_last_name]
        .filter((p): p is string => Boolean(p && p.trim().length > 0))
        .join(' ')
        .trim();
      if (fullName) additional['name'] = fullName;
      const existing =
        (payload['enrichments'] as Record<string, unknown> | undefined) ?? {};
      existing['contact_source'] = 'surma_ops_lookup';
      // Stamp the order-level fields on enrichments.order_info so they
      // show up in the Events inspector's JSON tree AND the admin can
      // bind them at rawPayload.enrichments.order_info.* in rule
      // conditions / template variables. The emit() path hoists these
      // to top-level event.* fields as well — the enrichments.* copy is
      // for FE sample-helper JSON path binding.
      existing['order_info'] = {
        payment_mode: body.payment_mode ?? null,
        cod_amount: body.cod_amount ?? null,
        order_total: body.order_total ?? null,
        financial_status: body.financial_status ?? null,
        order_tags: Array.isArray(body.order_tags) ? body.order_tags : [],
        currency: body.currency ?? null,
        products: typeof body.products === 'string' ? body.products : null,
      };
      payload['enrichments'] = existing;
      this.logger.log(
        `clickpost enrich: webhook_id=${webhookId} order=${orderId} ` +
          `waybill=${waybill ?? 'null'} ` +
          `unmasked phone=${body.customer_phone ? 'yes' : 'no'} ` +
          `email=${body.customer_email ? 'yes' : 'no'} ` +
          `payment_mode=${body.payment_mode ?? 'null'} ` +
          `cod_amount=${body.cod_amount ?? 'null'} ` +
          `order_total=${body.order_total ?? 'null'} ` +
          `products=${typeof body.products === 'string' ? `"${body.products.slice(0, 60)}${body.products.length > 60 ? '…' : ''}"` : 'null'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `clickpost enrich: webhook_id=${webhookId} order=${orderId} lookup failed: ${msg} — leaving masks`,
      );
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Read the raw `account_code` from the Clickpost payload, run it
   * through the brand registry, and stamp the clean brand name onto
   * `enrichments.courier_brand`. Pure derivation — no side-effects
   * beyond the in-place mutation; called before persistence so the
   * stored row + emit() + the FE event-sample tree all see the brand.
   *
   * Silent no-op when the account_code is missing OR doesn't match any
   * registered brand. Both cases leave `enrichments.courier_brand`
   * absent so templates binding `{{normalised_courier_partner_name}}`
   * render blank rather than printing a messy nickname.
   */
  private normaliseCourierPartner(payload: Record<string, unknown>): void {
    const additional = payload['additional'] as
      | Record<string, unknown>
      | undefined;
    // Clickpost ships account_code on BOTH the root AND additional —
    // we read root first (consistent with the existing emit() hoist),
    // then fall back to additional.
    const accountCode =
      asString(payload['account_code']) ??
      asString(additional?.['account_code']);
    const brand = extractCourierBrand(accountCode);
    if (!brand) return;
    const existing =
      (payload['enrichments'] as Record<string, unknown> | undefined) ?? {};
    existing['courier_brand'] = brand;
    payload['enrichments'] = existing;
  }

  /**
   * Natural key: (waybill, clickpost_status_code, timestamp). Same
   * shipment + same status code + same scan time ≡ same event. Falls
   * back to a hash of the raw body when any key component is missing.
   */
  private deriveWebhookId(payload: Record<string, unknown>): string {
    const waybill = asString(payload['waybill']);
    const codeRaw = payload['clickpost_status_code'];
    const code =
      typeof codeRaw === 'number'
        ? String(codeRaw)
        : asString(codeRaw);
    const timestamp = asString(payload['timestamp']);
    if (waybill && code && timestamp) {
      return `${waybill}:${code}:${timestamp}`;
    }
    const hash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    return `hash:${hash}`;
  }
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Registry of carrier brand regexes applied to Clickpost's messy
 * `account_code` field. The nickname is a merchant-side account label
 * that mixes carrier name + account type (forward/reverse) + payment
 * mode + hub + the word "Clickpost" — unusable for customer-facing
 * templates ("Your order is on its way via Bluedart Forward Prepaid Air
 * Surma Clickpost" reads badly). We substring-match against the carrier
 * brand only. Ordered by prod volume so cheap matches hit first.
 *
 * Extend here as new couriers come online — a new entry is additive;
 * ordering by volume keeps the hot path fastest.
 */
const COURIER_BRAND_REGISTRY: Array<{ needle: string; brand: string }> = [
  { needle: 'shadowfax', brand: 'Shadowfax' },
  { needle: 'bluedart', brand: 'Bluedart' },
  { needle: 'delhivery', brand: 'Delhivery' },
  { needle: 'shiprocket', brand: 'Shiprocket' },
];

function extractCourierBrand(accountCode: string | null): string | null {
  if (!accountCode) return null;
  const lowered = accountCode.toLowerCase();
  for (const { needle, brand } of COURIER_BRAND_REGISTRY) {
    if (lowered.includes(needle)) return brand;
  }
  return null;
}

/**
 * Registry of Clickpost status normalisations, keyed by the triple
 * `(latest_status.clickpost_status_code, latest_status.clickpost_status_bucket, additional.is_rvp)`.
 *
 * Confirmed from 7-day production data (2026-11-02):
 *   - `(code, bucket)` cleanly discriminates lifecycle stage (Delivered,
 *     OutForDelivery, InTransit, FailedDelivery, RTO, …)
 *   - `is_rvp` additionally splits forward (customer-bound) from
 *     reverse (customer-pickup bound for the warehouse) legs — important
 *     because the same `(8, 6)` tuple means "customer got their order"
 *     when forward and "warehouse got the return" when reverse. Those
 *     drive very different automations.
 *
 * Any triple not in the registry falls through to the raw Clickpost
 * `status` string — safe default, admin can still trigger automations
 * on it (just the raw inconsistent string). Extend here as the admin
 * discovers more statuses they want to automate on.
 *
 * Keys are formatted `code:bucket:is_rvp` for easy JSON-serialisable
 * table lookups; `is_rvp` is encoded as 'true'/'false' strings since
 * Clickpost ships it as a JSON boolean.
 */
const CLICKPOST_STATUS_NORMALISATION: Record<string, string> = {
  // Delivered lifecycle
  '8:6:false': 'Surma Order Delivered To Customer',
  '8:6:true': 'Surma Return Delivered To Warehouse',
  // Out-for-delivery lifecycle
  //   is_rvp=false → last-mile truck heading to the customer's door
  //   is_rvp=true  → last-mile truck heading to the Surma warehouse
  //                  (operational, not customer-facing — but still
  //                  surface it as a trigger so admin can wire ops /
  //                  internal notifications)
  '6:4:false': 'Surma Out For Delivery To Customer',
  '6:4:true': 'Surma Out For Delivery To Warehouse',
  // Out-for-pickup lifecycle
  //   is_rvp=false → Clickpost agent heading to the Surma warehouse to
  //                  collect a new order (= customer-facing "dispatched")
  //   is_rvp=true  → Clickpost agent heading to the customer to collect
  //                  their RVP return / exchange parcel
  '25:1:false': 'Surma Out For Pickup From Warehouse',
  '25:1:true': 'Surma Out For Pickup From Customer',
  // Picked-up lifecycle — one physical scan AFTER out-for-pickup; the
  // parcel is now in the courier's hands moving to the first hub.
  //   is_rvp=false → forward: order picked up from Surma warehouse
  //   is_rvp=true  → reverse: return picked up from customer
  //
  // Semantically close to (25, 1, *) — admins who wire templates to
  // both for the same customer touchpoint will double-fire.
  '4:2:false': 'Surma Picked Up From Warehouse',
  '4:2:true': 'Surma Picked Up From Customer',
};

function normaliseClickpostStatus(
  payload: Record<string, unknown>,
): string | null {
  const additional = payload['additional'] as
    | Record<string, unknown>
    | undefined;
  if (!additional) return null;
  const latest = additional['latest_status'] as
    | Record<string, unknown>
    | undefined;
  if (!latest) return null;
  const code = asString(latest['clickpost_status_code']);
  const bucket = asString(latest['clickpost_status_bucket']);
  // Clickpost always sends is_rvp as a JSON boolean. Guard against
  // the stray missing case by requiring an explicit true/false (so a
  // misshapen payload falls through to raw-status rather than
  // mis-labelling).
  const isRvpRaw = additional['is_rvp'];
  if (typeof isRvpRaw !== 'boolean') return null;
  if (!code || !bucket) return null;
  const key = `${code}:${bucket}:${isRvpRaw ? 'true' : 'false'}`;
  return CLICKPOST_STATUS_NORMALISATION[key] ?? null;
}
