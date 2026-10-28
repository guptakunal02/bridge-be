import { Injectable, Logger } from '@nestjs/common';
import type { Action, ActionHandler } from '../action';
import { AUTOMATION_EVENT, type AutomationEventPayload } from '../events';
import { resolveJsonPath } from '../json-path';

/**
 * call_webhook action. Fires an outbound HTTP request after resolving
 * `variable_bindings` against the triggering event's rawPayload and
 * substituting `{{name}}` placeholders in the URL + body_template.
 *
 * Shape mirrors send_whatsapp_template's variable_bindings — admin
 * declares `{var: "$.json.path"}` and the handler resolves each path,
 * then templates them into string leaves of body_template + into any
 * query-string segment of url.
 *
 * Logs outcome at info level (status code, response body preview); any
 * non-2xx / network error is a warn, never thrown — one bad webhook
 * never blocks the rest of a rule's actions.
 *
 * Timeout: 30s via AbortController. Longer than that and the firing
 * event has probably already lost the admin's attention. The receiver
 * is expected to accept + enqueue, not do its full work synchronously.
 */
@Injectable()
export class CallWebhookHandler
  implements ActionHandler<Extract<Action, { type: 'call_webhook' }>>
{
  readonly type = 'call_webhook' as const;
  private readonly logger = new Logger(CallWebhookHandler.name);

  async execute(
    action: Extract<Action, { type: 'call_webhook' }>,
    ctx: AutomationEventPayload,
  ): Promise<void> {
    const raw = extractRawPayload(ctx);

    // Resolve each binding once; results feed every {{name}}
    // substitution below. Null-resolving paths yield "" so the final
    // URL / body still formats correctly instead of leaking the literal
    // "{{awb}}" to the receiver.
    const resolved: Record<string, string> = {};
    if (action.variable_bindings) {
      for (const [name, path] of Object.entries(action.variable_bindings)) {
        const v = raw ? resolveJsonPath(raw, path) : null;
        resolved[name] = v ?? '';
      }
    }

    const url = substitute(action.url, resolved);
    const body =
      action.body_template === undefined
        ? undefined
        : substituteValue(action.body_template, resolved);

    const headers: Record<string, string> = { ...(action.headers ?? {}) };
    const hasBody = body !== undefined && body !== null;
    const canCarryBody =
      action.method !== 'GET' && action.method !== 'DELETE' && hasBody;
    if (canCarryBody && !pickHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: action.method,
        headers,
        body: canCarryBody ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      this.logger.warn(
        `call_webhook failed network: event=${ctx.event} ${action.method} ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    clearTimeout(timeout);

    const text = await res.text().catch(() => '');
    const preview = text.slice(0, 200);
    if (!res.ok) {
      this.logger.warn(
        `call_webhook non-2xx: event=${ctx.event} ${action.method} ${url} → ${res.status} ${res.statusText}: ${preview}`,
      );
      return;
    }
    this.logger.log(
      `call_webhook ok: event=${ctx.event} ${action.method} ${url} → ${res.status}${preview ? ` (${preview})` : ''}`,
    );
  }
}

/**
 * Pulls rawPayload off whichever event variant we received. Not every
 * event carries one (ticket.created / tag.applied are ticket-only),
 * and that's fine — the handler just skips path resolution and
 * leaves placeholders unsubstituted (yielding "" as the final value).
 */
function extractRawPayload(
  ctx: AutomationEventPayload,
): Record<string, unknown> | null {
  if (
    ctx.event === AUTOMATION_EVENT.WEBHOOK_CUSTOM ||
    ctx.event === AUTOMATION_EVENT.SHOPIFY_ORDER_CONFIRMED ||
    ctx.event === AUTOMATION_EVENT.SHOPIFY_ORDER_FULFILLED ||
    ctx.event === AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_CREATED ||
    ctx.event === AUTOMATION_EVENT.SHOPIFY_FULFILLMENT_UPDATED ||
    ctx.event === AUTOMATION_EVENT.LENS_NDR ||
    ctx.event === AUTOMATION_EVENT.LENS_NPR ||
    ctx.event === AUTOMATION_EVENT.WHATSAPP_BUTTON_REPLY
  ) {
    return ctx.payload.rawPayload ?? null;
  }
  return null;
}

/**
 * Case-insensitive header lookup. Fetch's Headers is case-insensitive
 * but we're using a plain Record<string,string>, so a Content-Type the
 * admin typed as "content-type" would otherwise collide with our
 * default's canonical casing.
 */
function pickHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * `{{name}}` → resolved[name] substitution on a flat string. Unknown
 * names leave their placeholder in place — the admin sees it in logs
 * and can fix the binding. We don't throw; a stray placeholder on a
 * query param beats silently sending the wrong URL.
 */
function substitute(input: string, resolved: Record<string, string>): string {
  return input.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name: string) =>
    name in resolved ? (resolved[name] ?? '') : match,
  );
}

/**
 * Deep-walks a JSON-ish value and substitutes `{{name}}` in string
 * leaves. Objects / arrays recurse; primitives pass through unchanged
 * (so `null`, `true`, `42` go to the wire as-is). This runs on the
 * body_template before JSON.stringify so the final request body has
 * the resolved values at the correct keys.
 */
function substituteValue(
  input: unknown,
  resolved: Record<string, string>,
): unknown {
  if (typeof input === 'string') return substitute(input, resolved);
  if (Array.isArray(input)) {
    return input.map((v) => substituteValue(v, resolved));
  }
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = substituteValue(v, resolved);
    }
    return out;
  }
  return input;
}
