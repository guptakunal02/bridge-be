import type { BotFunction } from './types';

/**
 * "Is this a new or a repeat customer?"
 *
 * Counts orders in surma_common_ops whose Shopify shipping-address
 * phone (last 10 digits, non-digits stripped) matches the supplied
 * number. That normalisation matches what the ops-side trigger
 * `set_order_materialised_fields` does when it computes
 * `orders.is_old_customer`, so the two agree.
 *
 * A count of 0 or 1 → new (first purchase or none). Anything higher
 * → repeat.
 */
export const getCustomerType: BotFunction = {
  key: 'get_customer_type',
  label: 'Get customer type',
  description:
    'Returns whether the customer has placed one order (new) or more than one (repeat), keyed by phone number.',
  inputs: [
    {
      key: 'phone',
      label: 'Customer phone number',
      type: 'string',
      required: true,
      description:
        'Any format — non-digits are stripped and the last 10 digits are matched.',
    },
  ],
  outputs: [
    {
      key: 'type',
      label: 'Customer type',
      type: 'enum',
      enumValues: ['new', 'repeat'],
    },
  ],
  handler: async (inputs, deps) => {
    const phone = inputs.phone;
    if (typeof phone !== 'string' || phone.trim() === '') {
      // The runtime validator normally catches missing required
      // inputs; defensive branch here so a handler crash doesn't
      // tank the entire flow.
      return { type: 'new' };
    }

    const row = await deps.opsRead.queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM orders
        WHERE RIGHT(
                regexp_replace(
                  COALESCE(raw_shopify_response->'shippingAddress'->>'phone', ''),
                  '\\D', '', 'g'
                ),
                10
              )
            = RIGHT(regexp_replace($1, '\\D', '', 'g'), 10)`,
      [phone],
    );
    const count = Number(row?.count ?? 0);
    return { type: count > 1 ? 'repeat' : 'new' };
  },
};
