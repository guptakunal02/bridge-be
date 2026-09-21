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
  id: string; // internal ops.orders.id
  orderName: string | null; // display "#123456"
  shopifyOrderId: string | null; // numeric id
  fulfillmentStatus: string | null; // e.g. "FULFILLED", "IN_TRANSIT"
  paymentStatus: string | null;
  placedAt: string | null;
  totalAmount: string | null; // pre-formatted with currency
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
    // Performance note: ops `orders` has no functional index on any
    // of the email JSON paths, so this WHERE alone would full-scan
    // the table. Two guardrails:
    //
    //   1. `ordered_at >= NOW() - INTERVAL '3 years'` — cuts the row
    //      set to what any support conversation could realistically
    //      reference. Uses `idx_orders_ordered_at` as an anchor so
    //      the seq-scan happens on a much smaller subset.
    //
    //   2. `SET LOCAL statement_timeout = 15s` — a runaway query
    //      returns a real error instead of hanging the UI. Wrapped
    //      in a txn so LOCAL sticks. Once the ops team lands the
    //      expression indexes on the email paths (see docs), both
    //      guardrails can loosen.
    const rows = await this.opsRead.transactional<OrdersRow>(
      async (q) => {
        await q('SET LOCAL statement_timeout = 15000');
        return q(
          `SELECT
             id,
             awb,
             normalised_current_status,
             cancelled_at,
             shopify_tags,
             raw_shopify_response,
             raw_clickpost_response,
             ordered_at
           FROM orders
           WHERE
             ordered_at >= NOW() - INTERVAL '3 years'
             AND (
                    lower(coalesce(raw_shopify_response->'shippingAddress'->>'email','')) = lower($1)
                 OR lower(coalesce(raw_shopify_response->'customer'->>'email','')) = lower($1)
                 OR lower(coalesce(raw_shopify_response->>'email','')) = lower($1)
                 )
           ORDER BY ordered_at DESC NULLS LAST
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
}

interface ShopifyRaw {
  id?: string | number;
  name?: string;
  createdAt?: string;
  processedAt?: string;
  currencyCode?: string;
  totalPriceSet?: {
    shopMoney?: { amount?: string; currencyCode?: string };
  };
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
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
  lineItems?: {
    nodes?: Array<{
      title?: string;
      name?: string;
      quantity?: number;
      originalUnitPriceSet?: {
        shopMoney?: { amount?: string; currencyCode?: string };
      };
      image?: { url?: string };
      variant?: { image?: { url?: string } };
    }>;
  };
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

  const lineItems =
    s.lineItems?.nodes?.map((n) => ({
      name: n.title ?? n.name ?? '(unnamed)',
      quantity: Number(n.quantity ?? 1),
      priceLabel: n.originalUnitPriceSet?.shopMoney?.amount
        ? `${n.originalUnitPriceSet.shopMoney.currencyCode ?? ''} ${n.originalUnitPriceSet.shopMoney.amount}`.trim()
        : null,
      imageUrl: n.variant?.image?.url ?? n.image?.url ?? null,
    })) ?? [];

  // Prefer Clickpost's tracking_url if present; else synthesise
  // Surma's Clickpost portal link from the pieces we have.
  const trackingUrl =
    c.tracking_url ??
    (c.security_key && (c.cp_id ?? c.waybill ?? row.awb)
      ? `https://surma.clickpost.ai?cp_id=${c.cp_id ?? ''}&waybill=${
          c.waybill ?? row.awb ?? ''
        }&security_key=${c.security_key}`
      : null);

  return {
    id: String(row.id),
    orderName: s.name ?? null,
    shopifyOrderId: s.id ? String(s.id) : null,
    fulfillmentStatus:
      s.displayFulfillmentStatus ?? row.normalised_current_status ?? null,
    paymentStatus: s.displayFinancialStatus ?? null,
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

function toIso(v: string | Date | null): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function clampLimit(n: number | undefined): number {
  if (!n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}
