import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpsReadService } from '../bot/ops/ops-read.service';
import { MessageDirection } from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { Ticket } from './entities/ticket.entity';

/**
 * Shape returned per row. All fields are optional because ops
 * source data (raw Shopify JSON) isn't always uniform — a partial
 * order still renders, we just skip unknown fields on the FE.
 */
export interface CustomerOrder {
  id: string; // internal ops.orders.id (uuid)
  orderName: string | null; // display like "#159288"
  orderNumber: string | null; // just the digits, e.g. "159288"
  shopifyOrderGid: string | null; // full gid, kept but not shown by default
  paymentStatus: string | null; // Shopify's displayFinancialStatus (PAID, PENDING, …)
  fulfillmentStatus: string | null; // Shopify's displayFulfillmentStatus (FULFILLED, UNFULFILLED)
  shipmentStatus: string | null; // raw courier code from ops (normalised_current_status)
  shipmentStatusLabel: string | null; // display-friendly ("Delivered", "In Transit", "Returned", …)
  /** True once a replacement order has been created for this order via the exchanges table. */
  isExchanged: boolean;
  /** Display order name of the replacement, when isExchanged. e.g. "#159289". */
  replacementOrderName: string | null;
  /** Timestamp the exchange request was created on ReturnPrime. */
  exchangeRequestedAt: string | null;
  placedAt: string | null;
  totalAmount: string | null;
  currency: string | null;
  invoiceName: string | null;
  phoneNumber: string | null;
  email: string | null;
  deliveryAddress: string | null;
  pincode: string | null;
  trackingUrl: string | null;
  awb: string | null;
  orderTags: string[];
  lineItems: Array<{
    name: string;
    quantity: number;
    priceLabel: string | null;
    imageUrl: string | null;
  }>;
}

export interface CustomerOrdersPage {
  orders: CustomerOrder[];
  hasMore: boolean;
  customerEmail: string | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 40;

@Injectable()
export class CustomerOrdersService {
  private readonly logger = new Logger(CustomerOrdersService.name);

  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(EmailMessage)
    private readonly emails: Repository<EmailMessage>,
    private readonly opsRead: OpsReadService,
  ) {}

  /**
   * Fetch a page of orders for the customer whose email opened this
   * ticket. Matching runs against three possible JSON paths in
   * `raw_shopify_response` (shippingAddress.email, customer.email,
   * top-level email) since Shopify's export shape varies across
   * order sources.
   */
  async listForTicket(
    ticketId: string,
    query: { limit?: number; offset?: number },
  ): Promise<CustomerOrdersPage> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const email = await this.pickCustomerEmail(ticketId);
    if (!email) {
      return { orders: [], hasMore: false, customerEmail: null };
    }

    const limit = clampLimit(query.limit);
    const offset = Math.max(0, query.offset ?? 0);

    // Fetch limit+1 to know whether there's a next page without a
    // second COUNT query. Cheap trick, standard cursor-lite paging.
    //
    // Column reference: the ops schema uses `ordered_at` (snake case)
    // as the canonical placed-at timestamp — verified against
    // surma-common-data-backend/src/orders/order.entity.ts.
    //
    // Index alignment: the three WHERE clauses each match one of
    // idx_orders_shipping_email / idx_orders_customer_email /
    // idx_orders_top_level_email (see the ops-side db/indexes.sql).
    // Each is a bare `lower(json_path->>'email')` with no coalesce
    // wrapper, because Postgres matches expressions structurally —
    // a coalesce wrapper would silently drop the index match and
    // fall back to a seq scan. NULL comparisons return NULL (falsy),
    // which is what we want anyway.
    //
    // Query timeout kept at 5s as a safety net — the indexed lookups
    // return well under 100ms even at millions of rows; anything
    // slower means the indexes weren't created or the plan went
    // wrong, and we want a clean error rather than a hanging UI.
    const rows = await this.opsRead.transactional<OrdersRow>(
      async (q) => {
        await q('SET LOCAL statement_timeout = 5000');
        return q(
          // LEFT JOIN LATERAL to `exchanges` picks up the most recent
          // exchange record for each order, if any. Ops indexes
          // exchanges on initial_shopify_order_id so this is a cheap
          // per-row probe. new_shopify_order_id is NULL while the
          // replacement order hasn't been created yet — we surface
          // "Exchanged" only once it exists (see the mapper), so an
          // in-flight-but-unfulfilled exchange keeps the underlying
          // shipment status.
          `SELECT
             o.id,
             o.awb,
             o.normalised_current_status,
             o.cancelled_at,
             o.shopify_tags,
             o.raw_shopify_response,
             o.raw_clickpost_response,
             o.ordered_at,
             o.shopify_order_id,
             e.new_shopify_order_id AS exchange_new_order_id,
             e.request_created_at   AS exchange_request_created_at
           FROM orders o
           LEFT JOIN LATERAL (
             SELECT new_shopify_order_id, request_created_at
             FROM exchanges
             WHERE initial_shopify_order_id = o.shopify_order_id
             ORDER BY request_created_at DESC NULLS LAST
             LIMIT 1
           ) e ON TRUE
           WHERE
                  lower((o.raw_shopify_response->'shippingAddress'->>'email')) = $1
               OR lower((o.raw_shopify_response->'customer'->>'email')) = $1
               OR lower((o.raw_shopify_response->>'email')) = $1
           ORDER BY o.ordered_at DESC NULLS LAST
           LIMIT $2 OFFSET $3`,
          [email, limit + 1, offset],
        );
      },
    );

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    return {
      orders: trimmed.map(toCustomerOrder),
      hasMore,
      customerEmail: email,
    };
  }

  /**
   * The customer's email is the sender of the earliest inbound
   * message on the ticket. Anything else (bot chatter, our own
   * replies) doesn't identify the customer.
   */
  private async pickCustomerEmail(ticketId: string): Promise<string | null> {
    const first = await this.emails.findOne({
      where: { ticket_id: ticketId, type: MessageDirection.RECEIVED },
      order: { createdAt: 'ASC' },
    });
    const raw = first?.sender?.trim() ?? null;
    return raw ? raw.toLowerCase() : null;
  }
}

interface OrdersRow {
  id: string | number;
  awb: string | null;
  normalised_current_status: string | null;
  cancelled_at: string | null;
  shopify_tags: string[] | null;
  raw_shopify_response: ShopifyRaw | null;
  raw_clickpost_response: ClickpostRaw | null;
  ordered_at: string | Date | null;
  shopify_order_id: string | null;
  exchange_new_order_id: string | null;
  exchange_request_created_at: string | Date | null;
}

// Shopify's export shape differs between REST (line_items[]) and
// GraphQL (lineItems.nodes[] or lineItems.edges[].node). We try
// every known path so a row that came in via a different pipeline
// doesn't silently render an empty items list.
type ShopifyLineItem = {
  title?: string;
  name?: string;
  quantity?: number;
  price?: string;
  originalUnitPriceSet?: {
    shopMoney?: { amount?: string; currencyCode?: string };
  };
  image?: { url?: string; src?: string };
  variant?: { image?: { url?: string; src?: string } };
};

interface ShopifyRaw {
  id?: string | number;
  name?: string;
  createdAt?: string;
  processedAt?: string;
  currencyCode?: string;
  totalPriceSet?: {
    shopMoney?: { amount?: string; currencyCode?: string };
  };
  total_price?: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  email?: string;
  tags?: string[] | string;
  customer?: { email?: string };
  shippingAddress?: {
    address1?: string;
    address2?: string;
    city?: string;
    zip?: string;
    province?: string;
    country?: string;
    phone?: string;
    email?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  };
  // GraphQL: lineItems.nodes[] or lineItems.edges[].node
  lineItems?: {
    nodes?: ShopifyLineItem[];
    edges?: Array<{ node: ShopifyLineItem }>;
  };
  // REST: snake-cased array
  line_items?: ShopifyLineItem[];
}

interface ClickpostRaw {
  tracking_url?: string;
  security_key?: string;
  cp_id?: number | string;
  waybill?: string;
}

function toCustomerOrder(row: OrdersRow): CustomerOrder {
  const s = row.raw_shopify_response ?? {};
  const c = row.raw_clickpost_response ?? {};

  const totalAmount = s.totalPriceSet?.shopMoney?.amount ?? null;
  const currency =
    s.totalPriceSet?.shopMoney?.currencyCode ?? s.currencyCode ?? null;

  // Prefer the first-class `shopify_tags text[]` column; fall back
  // to whatever the raw Shopify JSON carried (older rows).
  const tags: string[] =
    row.shopify_tags && row.shopify_tags.length > 0
      ? row.shopify_tags
      : Array.isArray(s.tags)
        ? s.tags
        : typeof s.tags === 'string'
          ? s.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [];

  const addr = s.shippingAddress ?? {};
  const composedName =
    [addr.firstName, addr.lastName].filter(Boolean).join(' ').trim() || null;
  const invoiceName = addr.name ?? composedName;
  const deliveryAddress =
    [
      addr.address1,
      addr.address2,
      [addr.city, addr.province].filter(Boolean).join(' '),
      addr.country,
    ]
      .filter(Boolean)
      .join(', ') || null;

  // Pick line items from whichever Shopify export shape this row
  // was ingested with. REST rows carry `line_items[]`, GraphQL rows
  // put the array under `lineItems.nodes[]` or under
  // `lineItems.edges[].node` depending on the query flavour used.
  const rawItems: ShopifyLineItem[] =
    s.lineItems?.nodes ??
    s.lineItems?.edges?.map((e) => e.node) ??
    s.line_items ??
    [];
  const lineItems = rawItems.map((n) => {
    const priceAmount =
      n.originalUnitPriceSet?.shopMoney?.amount ?? n.price ?? null;
    const priceCurrency =
      n.originalUnitPriceSet?.shopMoney?.currencyCode ??
      s.totalPriceSet?.shopMoney?.currencyCode ??
      s.currencyCode ??
      null;
    return {
      name: n.title ?? n.name ?? '(unnamed)',
      quantity: Number(n.quantity ?? 1),
      priceLabel: priceAmount
        ? `${priceCurrency ?? ''} ${priceAmount}`.trim()
        : null,
      imageUrl:
        n.variant?.image?.url ??
        n.variant?.image?.src ??
        n.image?.url ??
        n.image?.src ??
        null,
    };
  });

  // Prefer Clickpost's tracking_url if present; else synthesise
  // Surma's Clickpost portal link from the pieces we have.
  const trackingUrl =
    c.tracking_url ??
    (c.security_key && (c.cp_id ?? c.waybill ?? row.awb)
      ? `https://surma.clickpost.ai?cp_id=${c.cp_id ?? ''}&waybill=${
          c.waybill ?? row.awb ?? ''
        }&security_key=${c.security_key}`
      : null);

  // The number-only order id — "#159288" → "159288". Falls back to
  // the raw name if it doesn't lead with a hash.
  const orderNumber =
    s.name && s.name.startsWith('#') ? s.name.slice(1) : (s.name ?? null);

  const shipmentStatus = row.normalised_current_status;

  // Exchange derivation: only considered "exchanged" once the ops
  // exchanges table has a linked replacement order (new_shopify_order_id
  // populated). In-flight exchange requests without a replacement yet
  // keep the underlying shipment status — no false positive.
  const isExchanged = Boolean(row.exchange_new_order_id);
  const replacementOrderName = row.exchange_new_order_id
    ? `#${row.exchange_new_order_id}`
    : null;
  const exchangeRequestedAt = toIso(row.exchange_request_created_at);

  // When the exchange is complete, override the display label to
  // "Exchanged" — that's the customer-facing truth. The raw
  // shipmentStatus code (usually DELIVERED, since the customer
  // received the item before requesting an exchange) is preserved
  // so the FE / any consumer can still see it.
  const shipmentStatusLabel = shipmentStatus
    ? isExchanged
      ? 'Exchanged'
      : labelForShipmentStatus(shipmentStatus)
    : isExchanged
      ? 'Exchanged'
      : null;

  return {
    id: String(row.id),
    orderName: s.name ?? null,
    orderNumber,
    shopifyOrderGid: s.id ? String(s.id) : null,
    fulfillmentStatus:
      s.displayFulfillmentStatus ?? s.fulfillment_status ?? null,
    paymentStatus: s.displayFinancialStatus ?? s.financial_status ?? null,
    shipmentStatus,
    shipmentStatusLabel,
    isExchanged,
    replacementOrderName,
    exchangeRequestedAt,
    placedAt: toIso(row.ordered_at) ?? s.createdAt ?? s.processedAt ?? null,
    totalAmount,
    currency,
    invoiceName,
    phoneNumber: addr.phone ?? null,
    email: addr.email ?? s.customer?.email ?? s.email ?? null,
    deliveryAddress,
    pincode: addr.zip ?? null,
    trackingUrl,
    awb: row.awb,
    orderTags: tags,
    lineItems,
  };
}

/**
 * Map the raw normalised_current_status enum values (from the ops
 * ShipmentStatus enum) into user-friendly labels the agent sees.
 * Exchange isn't a shipment state — Shopify tracks that on the
 * order tag / return record, so it doesn't show up here.
 */
function labelForShipmentStatus(code: string): string {
  switch (code) {
    case 'DELIVERED':
      return 'Delivered';
    case 'OUT_FOR_DELIVERY':
      return 'Out for Delivery';
    case 'PICKED':
    case 'MISROUTED':
    case 'FAILED_DELIVERY_RETRYING':
      return 'In Transit';
    case 'PRE_PICKUP':
      return 'Preparing';
    case 'RTO_CANCELLED':
    case 'RTO_FAILED_DELIVERY':
    case 'RTO_DELIVERED_TO_ORIGIN':
      return 'Returned';
    case 'CANCELLED':
      return 'Cancelled';
    case 'LOST':
      return 'Lost';
    case 'NO_SHIPMENT_INFO':
      return 'Not shipped';
    default:
      // Unknown ops enum value — surface it verbatim so we notice
      // and don't silently swallow.
      return code;
  }
}

function toIso(v: string | Date | null): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function clampLimit(n: number | undefined): number {
  if (!n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}
