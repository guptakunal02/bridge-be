/**
 * Shape of the `buttons` jsonb column on WhatsappTemplate. Meta
 * supports up to 3 buttons per template and three distinct kinds:
 *
 *   URL          — opens a link in the customer's browser. The URL
 *                  can embed `{{1}}` for a per-send dynamic suffix,
 *                  but V1 keeps it static (no variables).
 *   PHONE_NUMBER — tap-to-call. Max one per template.
 *   QUICK_REPLY  — tap sends the button's text back as an inbound
 *                  message; useful for "YES / NO / MAYBE" style flows.
 *
 * The three shapes share `type` + `text` and diverge on the third
 * field; a discriminated union keeps the TS compiler happy on both
 * the create path (admin input) and the Meta payload builder.
 *
 * Text labels: Meta caps at 25 chars. We enforce in the FE and the
 * BE validator both — a 26-char label rejected by Meta is a terrible
 * admin experience vs. a clean "too long" at save time.
 */
export type WhatsappTemplateButton =
  | {
      type: 'URL';
      text: string;
      url: string;
      /**
       * When the admin wrote `{{var}}` in the URL (e.g.
       * `https://ops.teev.shop/ndr/reattempt?awb={{awb}}`), we store
       * the variable name here. Meta's template API caps dynamic URL
       * variables at one per button, so this is a single-string field
       * not an array. The service also adds the variable to the
       * template's variableMapping so the automation rule can bind it
       * the same way as body variables (recipient_phone_path,
       * variable_bindings on action.ts). Null for static-URL buttons.
       */
      url_variable_name?: string | null;
    }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | {
      type: 'QUICK_REPLY';
      text: string;
      /**
       * Admin-defined slug (e.g. "cancel_pickup") that automation
       * rules filter on when the customer taps the button. At send
       * time the handler encodes `{button_id, ctx}` as JSON into
       * Meta's per-button `payload` parameter — then on inbound we
       * parse it back and emit `whatsapp.button_reply` with
       * `button_id` + the resolved context as the event payload.
       *
       * Defaults to slugified `text` (lowercase, spaces → underscores)
       * when the admin leaves it blank. Kept URL-safe so admins can
       * also match it in predicates without quoting.
       */
      button_id?: string;
    };

/**
 * Lowercased, underscore-joined, [a-z0-9_]-only slug derived from a
 * button's visible text. Fallback for `button_id` when the admin
 * leaves it blank. Trims leading/trailing underscores; collapses runs
 * so "  Cancel  Pickup! " → "cancel_pickup".
 */
export function slugifyButtonId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Returns the effective button_id for a QUICK_REPLY button — the
 * admin-set slug if present + non-empty, else a slugified `text`.
 * Keeping this in one place so send-time (payload encoding) and
 * ingest-time (filter matching) agree on the same string.
 */
export function resolveButtonId(button: {
  type: 'QUICK_REPLY';
  text: string;
  button_id?: string;
}): string {
  const explicit = button.button_id?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return slugifyButtonId(button.text);
}

/**
 * Extracts the single `{{varname}}` from a dynamic URL. Returns null
 * if the URL has no placeholder or has more than one (Meta rejects
 * multi-variable URL buttons on submission). Shared between service
 * create() and send-time handler so both see the same name.
 */
export function extractUrlVariableName(url: string): string | null {
  const matches = [...url.matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}/g)];
  if (matches.length !== 1) return null;
  const name = matches[0]?.[1];
  return name ?? null;
}

export const WHATSAPP_BUTTON_TEXT_MAX = 25;
export const WHATSAPP_BUTTONS_MAX_COUNT = 3;
export const WHATSAPP_FOOTER_TEXT_MAX = 60;
export const WHATSAPP_HEADER_TEXT_MAX = 60;
