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
  | { type: 'URL'; text: string; url: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'QUICK_REPLY'; text: string };

export const WHATSAPP_BUTTON_TEXT_MAX = 25;
export const WHATSAPP_BUTTONS_MAX_COUNT = 3;
export const WHATSAPP_FOOTER_TEXT_MAX = 60;
export const WHATSAPP_HEADER_TEXT_MAX = 60;
