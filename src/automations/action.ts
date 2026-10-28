import type { TicketStatus } from '../database/enums';
import type { AutomationEventPayload } from './events';

/**
 * V1 action types. Each handler mutates ticket state and MUST be
 * idempotent — if the target state is already in effect (tag
 * already present, status already set), the handler short-circuits
 * without a DB write. That short-circuit is what breaks event
 * cascades (see events.ts: no state write → no follow-on event
 * emitted → no loop).
 */
export type ActionType =
  | 'add_tag'
  | 'remove_tag'
  | 'set_status'
  | 'set_assignee'
  | 'set_team'
  | 'send_whatsapp_template'
  | 'send_email_template'
  | 'opt_out_customer'
  | 'call_webhook';

export type Action =
  | { type: 'add_tag'; tagName: string }
  | { type: 'remove_tag'; tagName: string }
  | { type: 'set_status'; status: TicketStatus }
  | {
      type: 'set_assignee';
      /** User id to assign to. `null` sends the ticket back to the
       *  BOT queue (i.e. "unassign"). */
      userId: string | null;
    }
  | { type: 'set_team'; teamId: string }
  | {
      type: 'opt_out_customer';
      /**
       * Human-readable label stored on Customer.opted_out_keyword
       * so an admin inspecting the opted-out list can trace WHY
       * a particular contact was opted out (which rule matched).
       * Optional — handler falls back to "automation" when absent.
       *
       * NOTE: this label is diagnostic only — it never participates
       * in matching or filtering. Change it freely at any time.
       */
      reasonLabel?: string;
    }
  | {
      type: 'send_whatsapp_template';
      /**
       * UUID of a whatsapp_template row. Handler loads it at exec
       * time + verifies the ticket is a WhatsApp ticket (otherwise
       * skips with a warn log — WhatsApp templates are channel-
       * specific). Variables resolve from the ticket + customer DB
       * via the shared TemplateVariableResolver; the template's
       * stored fallbacks fill null slots. Only APPROVED templates
       * are sendable — PENDING / REJECTED rows reject at exec time
       * with a log line.
       */
      templateId: string;
      /**
       * Phase 4 — event-driven sends (Shopify / Clickpost / Return
       * Prime webhooks). When present, the handler resolves the
       * recipient's phone number from this JSON path against the
       * full webhook payload (e.g. "additional.phone" for Clickpost,
       * "customer.default_address.phone" for Shopify). Null/absent
       * means: fall back to the pre-populated payload.customerPhone
       * (the pre-Phase-4 shape — kept for backward compat with any
       * existing rules).
       */
      recipient_phone_path?: string;
      /**
       * Phase 4 — map each template variable to a JSON path in the
       * webhook payload. Keys are variable names (as declared in
       * the template body: `{{order_id}}` → key "order_id"); values
       * are dot-paths (e.g. "additional.order_id"). At send time
       * the handler resolves each path, falls back to the template's
       * stored fallback string when the path yields null/undefined,
       * and finally to "" if no fallback exists.
       *
       * Null/absent means: use the legacy path (handler reads
       * pre-populated payload.variables[name] keyed by the template's
       * variableMapping[]). This keeps existing automations working
       * unchanged.
       */
      variable_bindings?: Record<string, string>;
      /**
       * Phase 4 — JSON path to a per-send image URL for templates whose
       * header_type is IMAGE. Three-tier fallback at send time:
       *   1. resolveJsonPath(payload, header_image_path)
       *   2. header_image_fallback   (admin's static backup URL)
       *   3. template.headerMediaUrl (the sample uploaded for Meta)
       * Only honored when the template has IMAGE header; ignored otherwise.
       */
      header_image_path?: string;
      /**
       * Phase 4 — static backup image URL. Used when header_image_path
       * resolves to null, OR when there's no header_image_path at all.
       * Must be publicly reachable (Meta fetches it at send time).
       */
      header_image_fallback?: string;
    }
  | {
      type: 'send_email_template';
      /**
       * UUID of an email_template row. Handler asserts the ticket
       * is an email ticket. Variables resolve from the ticket +
       * customer DB; template fallbacks fill nulls. Subject + body
       * render with the resolved values, then fire through
       * EmailSenderService.sendReply so the SENT message threads
       * on the ticket's existing conversation (same In-Reply-To
       * stitching as a human-authored reply).
       */
      templateId: string;
    }
  | {
      type: 'call_webhook';
      /**
       * HTTP verb. GET / DELETE ignore `body_template`; the rest
       * send it as a JSON body with Content-Type: application/json
       * (unless the admin overrides via `headers`).
       */
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      /**
       * Target endpoint. Admin-authored string with no path-
       * variable interpolation — if the admin needs a dynamic
       * path segment they put it in a query param and let the
       * receiver route on that. Keeps the config shape simple.
       */
      url: string;
      /**
       * Optional static headers. Key/value map; both strings.
       * Content-Type defaults to application/json when a body is
       * present and the admin didn't set it explicitly.
       */
      headers?: Record<string, string>;
      /**
       * Request body skeleton as a JS value — object, array, or
       * primitive. String leaves containing `{{var}}` resolve
       * against the event payload (via `variable_bindings` paths)
       * before serialization; non-string leaves pass through as-is.
       *
       * Example (NPR cancel-pickup):
       *   {
       *     requestType: "{{type}}",
       *     requestId:   "{{request_id}}",
       *     awb:         "{{awb}}"
       *   }
       * with variable_bindings { type: "$.type", request_id: "$.request_id", awb: "$.awb" }
       */
      body_template?: unknown;
      /**
       * Same binding mechanic as send_whatsapp_template:
       * variable name → JSON path against the event's rawPayload.
       * Resolved values substitute every `{{name}}` placeholder in
       * `body_template` string leaves AND in query-string params
       * of `url`. Null-resolving paths yield empty strings in the
       * output.
       */
      variable_bindings?: Record<string, string>;
    };

/**
 * Contract every action handler implements. Receives the dispatched
 * event (so the handler can see payload + ticket snapshot) and the
 * typed action payload. Handlers log their own outcomes; the
 * dispatcher just wires action.type → handler.
 */
export interface ActionHandler<A extends Action = Action> {
  readonly type: A['type'];
  execute(action: A, ctx: AutomationEventPayload): Promise<void>;
}
