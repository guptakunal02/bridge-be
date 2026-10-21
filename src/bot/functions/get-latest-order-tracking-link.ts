import type { BotFunction } from './types';

/**
 * "What's the tracking link for this customer's most recent order?"
 *
 * Looks up the latest Shopify order for the given phone number
 * (last-10-digit match, same normalisation as get_customer_type)
 * and extracts the Clickpost tracking URL from Shopify's fulfillments
 * payload.
 *
 * On the ops side the Surma Clickpost tracking URL is stored
 * on `raw_shopify_response.fulfillments[0].trackingInfo[0].url`
 * (Clickpost pushes the fully-assembled surma.clickpost.ai URL into
 * Shopify's Fulfillment API; we mirror it from there instead of
 * trying to mint it from raw_clickpost_response).
 *
 * Return shape — the handler ALWAYS returns `trackingLink` and
 * `orderId`, each either populated or null. Both come from the same
 * row so the `found` outcome guarantees a non-null `orderId` on the
 * happy path (needed by downstream Message steps that want to echo
 * the order number back to the customer).
 */
export const getLatestOrderTrackingLink: BotFunction = {
  key: 'get_latest_order_tracking_link',
  label: 'Get latest order tracking link',
  description:
    'Looks up the latest Shopify order on this customer\'s phone and returns the tracking URL (null if no order or no tracking link available yet).',
  inputs: [
    {
      key: 'phone',
      label: 'Customer phone number',
      type: 'string',
      required: true,
      description:
        'Any format — non-digits are stripped, last 10 digits matched against the shipping-address + customer phone columns.',
    },
  ],
  outputs: [
    {
      key: 'trackingLink',
      label: 'Tracking link',
      type: 'string',
      description:
        'Clickpost tracking URL from the latest order. Null if no order found, or if the latest order has no tracking info yet (e.g. placed but not fulfilled).',
    },
    {
      key: 'orderId',
      label: 'Order id',
      type: 'string',
      description:
        'Shopify order name (e.g. "#239154") from the latest order on this customer. Null if no order found.',
    },
  ],
  outcomes: [
    {
      key: 'found',
      label: 'Order found',
      description:
        'Latest order located AND it has a tracking URL from Shopify fulfillments. ${trackingLink} is set.',
    },
    {
      key: 'not_found',
      label: 'No tracking link',
      description:
        'Either no order on this phone, or the latest order has no fulfillment yet. ${trackingLink} is null.',
    },
  ],
  handler: async (inputs, deps) => {
    const phone = inputs.phone;
    if (typeof phone !== 'string' || phone.trim() === '') {
      return {
        outcome: 'not_found',
        outputs: { trackingLink: null, orderId: null },
      };
    }

    // Match on shipping-address phone OR customer-object phone, same
    // approach as get_customer_type + findLatestOrderByPhone. Latest
    // order wins (ordered_at DESC). `order_id` comes from Shopify's
    // `name` field (the "#239154" the customer sees), not the numeric
    // legacyResourceId — the former is what customers reference back.
    const row = await deps.opsRead.queryOne<{
      tracking_url: string | null;
      order_id: string | null;
    }>(
      `SELECT raw_shopify_response
                #>> '{fulfillments,0,trackingInfo,0,url}' AS tracking_url,
              raw_shopify_response ->> 'name' AS order_id
         FROM orders
         WHERE RIGHT(
                 regexp_replace(
                   COALESCE(raw_shopify_response->'shippingAddress'->>'phone', ''),
                   '\\D', '', 'g'
                 ),
                 10
               ) = RIGHT(regexp_replace($1, '\\D', '', 'g'), 10)
            OR RIGHT(
                 regexp_replace(
                   COALESCE(raw_shopify_response->'customer'->>'phone', ''),
                   '\\D', '', 'g'
                 ),
                 10
               ) = RIGHT(regexp_replace($1, '\\D', '', 'g'), 10)
         ORDER BY ordered_at DESC NULLS LAST
         LIMIT 1`,
      [phone],
    );
    const link = row?.tracking_url ?? null;
    const orderId = row?.order_id ?? null;
    return {
      outcome: link ? 'found' : 'not_found',
      outputs: { trackingLink: link, orderId },
    };
  },
};
