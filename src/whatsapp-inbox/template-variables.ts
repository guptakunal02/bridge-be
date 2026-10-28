/**
 * Registry of every variable name an author can reference in a
 * template body (via `{{varname}}`). This is the source of truth for:
 *   * Autocomplete when the author types `{{` in the dialog (FE
 *     mirrors this list in a parallel constant — keep in sync).
 *   * Server-side validation on template create — unknown names are
 *     rejected before we POST to Meta.
 *   * The resolver that fills {{1}}, {{2}}, … positional parameters
 *     at send time, pulling from ticket + customer context.
 *
 * `nullableByChannel` encodes which variables CAN resolve to null in
 * each channel context — WhatsApp tickets always carry a phone number
 * but may not have an email on file; email tickets are the inverse.
 * The author MUST provide a fallback for every nullable-in-this-
 * channel variable they reference at save time; the resolver swaps
 * in the fallback whenever it hits a null.
 *
 * V1 only services WhatsApp templates; EMAIL rows are already here
 * so the forthcoming Email Outreach surface can reuse this registry
 * without a migration.
 */
export type VariableChannel = 'WHATSAPP' | 'EMAIL';

export interface TemplateVariable {
  name: string;
  label: string;
  category: 'ticket' | 'customer';
  description: string;
  /**
   * Per-channel null-safety. `true` → the resolver may return null
   * for this variable in that channel context, so the author must
   * provide a fallback at save time. `false` → always set.
   */
  nullableByChannel: Record<VariableChannel, boolean>;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  // --- Ticket variables ---------------------------------------
  {
    name: 'ticket_id',
    label: 'Ticket ID',
    category: 'ticket',
    description: 'The Bridge ticket number — unique per workspace.',
    nullableByChannel: { WHATSAPP: false, EMAIL: false },
  },
  {
    name: 'inbox',
    label: 'Inbox name',
    category: 'ticket',
    description: 'Human-readable channel name (e.g. "Support").',
    nullableByChannel: { WHATSAPP: false, EMAIL: false },
  },
  {
    name: 'order_id',
    label: 'Order ID',
    category: 'ticket',
    description:
      'The most-recent Shopify order linked to this customer (e.g. "#1234"). Not every customer has one.',
    nullableByChannel: { WHATSAPP: true, EMAIL: true },
  },
  {
    name: 'customer_id',
    label: 'Customer ID',
    category: 'ticket',
    description:
      "The customer's thread key — email for email tickets, phone for WhatsApp.",
    nullableByChannel: { WHATSAPP: false, EMAIL: false },
  },

  // --- Customer variables -------------------------------------
  {
    name: 'first_name',
    label: 'First name',
    category: 'customer',
    description: "From the most recent order's shipping address.",
    nullableByChannel: { WHATSAPP: true, EMAIL: true },
  },
  {
    name: 'last_name',
    label: 'Last name',
    category: 'customer',
    description: "From the most recent order's shipping address.",
    nullableByChannel: { WHATSAPP: true, EMAIL: true },
  },
  {
    name: 'email',
    label: 'Email',
    category: 'customer',
    description:
      "Customer's email address. Mandatory on EMAIL tickets, optional on WHATSAPP.",
    nullableByChannel: { WHATSAPP: true, EMAIL: false },
  },
  {
    name: 'phone_number',
    label: 'Phone number',
    category: 'customer',
    description:
      "Customer's phone / WhatsApp number (E.164). Mandatory on WHATSAPP tickets, optional on EMAIL.",
    nullableByChannel: { WHATSAPP: false, EMAIL: true },
  },
];

/** Fast lookup used by validators + resolvers. */
export const TEMPLATE_VARIABLES_BY_NAME: Record<string, TemplateVariable> =
  Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.name, v]));

/**
 * True if the variable can resolve to null in the given channel's
 * tickets — the author must provide a fallback in that case.
 */
export function isNullableFor(
  variable: TemplateVariable,
  channel: VariableChannel,
): boolean {
  return variable.nullableByChannel[channel];
}

/**
 * Pull every `{{name}}` reference out of a template body in the
 * order they first appear. Used to:
 *   * validate against the registry
 *   * assign positional ids ({{1}}, {{2}}, …) when converting to
 *     Meta's send payload
 *   * drive the FE's "Fallbacks" section (one row per unique name)
 */
export function extractVariableReferences(body: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
  }
  return refs;
}

/**
 * Replace every `{{varname}}` in `body` with `replacements[varname]`,
 * leaving unknown names untouched (defensive — the save-time
 * validator should have caught them). Used by the preview renderer.
 */
export function renderNamedBody(
  body: string,
  replacements: Record<string, string>,
): string {
  return body.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (match, name: string) => {
    const r = replacements[name];
    return r === undefined ? match : r;
  });
}

/**
 * Convert a named-reference body (`Hi {{first_name}}, order
 * #{{order_id}} shipped.`) into Meta's positional form
 * (`Hi {{1}}, order #{{2}} shipped.`) + the ordered list of names
 * each position maps to. Each name appears exactly once in `order`
 * (first-reference wins); repeated references in the body get the
 * same positional id so send-time only resolves + sends N distinct
 * values.
 */
export function convertNamedBodyToPositional(body: string): {
  positionalBody: string;
  orderedNames: string[];
} {
  const orderedNames = extractVariableReferences(body);
  const nameToPos = new Map<string, number>();
  orderedNames.forEach((n, i) => nameToPos.set(n, i + 1));
  const positionalBody = body.replace(
    /\{\{([a-z_][a-z0-9_]*)\}\}/g,
    (match, name: string) => {
      const pos = nameToPos.get(name);
      return pos ? `{{${pos}}}` : match;
    },
  );
  return { positionalBody, orderedNames };
}

/**
 * Shape persisted in `whatsapp_template.variable_mapping`. One entry
 * per unique variable name in the body, in the order they first
 * appeared (which also matches their {{1}}, {{2}}, … positional ids
 * in Meta's body).
 *
 *   fallback — used at SEND time when the resolver returns null for
 *              this variable. Short default like "there" for first_name.
 *   example  — passed to Meta ONLY at template-submission time as the
 *              example.body_text sample. If the author pulled this from
 *              a real recent event via the authoring UI's event-sample
 *              helper, Meta's reviewer sees realistic data (e.g.
 *              "Nilambri" instead of a generic "sample"), which
 *              improves approval rates for templates whose placeholders
 *              would otherwise look empty / generic. Not involved in
 *              send-time resolution.
 */
export interface VariableMappingEntry {
  name: string;
  fallback: string | null;
  example?: string | null;
}
