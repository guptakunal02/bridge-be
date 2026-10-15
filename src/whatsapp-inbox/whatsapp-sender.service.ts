import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation';

/**
 * Shape of the Meta Graph API message send response. Only `messages[0].id`
 * (the wamid) is load-bearing — we persist it so webhook retries of this
 * same message dedupe against the SENT row we're about to write.
 */
interface MetaSendResponse {
  messaging_product: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
}

/**
 * Error envelope Meta returns on any 4xx / some 5xx. error.code is the
 * machine-readable classifier; message is already human-friendly from
 * Meta's side so we can surface it to the agent.
 */
interface MetaErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

export interface WhatsappSendResult {
  wamid: string;
  raw: MetaSendResponse;
}

/**
 * Thin stateless client for sending WhatsApp text messages via Meta
 * Graph API. Mirrors EmailSenderService in shape — the tickets service
 * resolves ticket + channel + recipient context and hands over a plain
 * value; this service does ONE HTTP call and returns the Meta-issued
 * wamid.
 *
 * Why keep it this narrow:
 *   * V3 supports text payloads only. Media / templates / interactive
 *     messages each have different request shapes and are discrete
 *     feature slices (V4+).
 *   * Keeping the service I/O-shaped (sendText) rather than DB-shaped
 *     (sendReply + persist) means the caller stays in charge of the
 *     txn boundary around persistence — same pattern email uses.
 */
@Injectable()
export class WhatsappSenderService {
  private readonly logger = new Logger(WhatsappSenderService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  /**
   * Send a plain-text WhatsApp message to a recipient wa_id. Returns
   * the Meta wamid (which webhook retries use as idempotency key) +
   * the raw response for forensics.
   *
   * Throws BadRequestException with a friendly message on known Meta
   * error classes:
   *   * 131026 → Customer's WhatsApp number can't receive the message
   *               (uninstalled / blocked / outside WhatsApp coverage)
   *   * 131047 → 24-hour customer-service window has expired; we need
   *               to send an approved template instead (V4)
   *   * 131051 → Unsupported message type (shouldn't happen for text)
   *   * 190    → Access token expired / revoked — rotate WHATSAPP_
   *               ACCESS_TOKEN and redeploy
   * Any other code bubbles as a 400 so the FE surfaces it verbatim.
   *
   * Network errors bubble as 500 — those are either Meta transient
   * failures (agent retries) or our egress being blocked (ops fixes).
   */
  async sendText(
    waId: string,
    body: string,
  ): Promise<WhatsappSendResult> {
    const digits = waId.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('Recipient wa_id missing or invalid');
    }
    const trimmed = body.trim();
    if (!trimmed) {
      throw new BadRequestException('Message body is empty');
    }

    const phoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: digits,
      type: 'text',
      text: { preview_url: false, body: trimmed },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (netErr) {
      // Network-layer failure (DNS, TCP, TLS). Bubble as-is — Nest
      // turns it into a 500 and the FE prompts the agent to retry.
      this.logger.error(
        `WhatsApp send network error for wa_id=${digits}: ${
          netErr instanceof Error ? netErr.message : String(netErr)
        }`,
      );
      throw netErr;
    }

    const text = await res.text();
    let parsed: MetaSendResponse & MetaErrorEnvelope;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      this.logger.error(
        `WhatsApp send: non-JSON response (status=${res.status}): ${text.slice(0, 500)}`,
      );
      throw new BadRequestException(
        'WhatsApp send failed — Meta returned an unexpected response',
      );
    }

    if (!res.ok || parsed.error) {
      const code = parsed.error?.code;
      const metaMsg =
        parsed.error?.error_user_msg || parsed.error?.message || 'Unknown error';
      this.logger.warn(
        `WhatsApp send rejected status=${res.status} code=${code ?? 'none'} fbtrace=${parsed.error?.fbtrace_id ?? ''} msg="${metaMsg}"`,
      );
      throw new BadRequestException(friendlyError(code, metaMsg));
    }

    const wamid = parsed.messages?.[0]?.id;
    if (!wamid) {
      // Should never happen when Meta accepts a send — but if it does,
      // storing a null external_message_id breaks dedup against the
      // webhook delivery, so reject instead.
      this.logger.error(
        `WhatsApp send: 2xx but no wamid in response: ${text.slice(0, 500)}`,
      );
      throw new BadRequestException(
        'WhatsApp send failed — Meta did not return a message id',
      );
    }
    this.logger.log(
      `WhatsApp send ok: wa_id=${digits} wamid=${wamid}`,
    );
    return { wamid, raw: parsed };
  }
}

/**
 * Translate a Meta error code into a message the FE can show the
 * agent. Falls back to Meta's own message for anything we haven't
 * explicitly classified — Meta's text is usually self-explanatory.
 */
function friendlyError(code: number | undefined, metaMsg: string): string {
  switch (code) {
    case 131026:
      return "Customer's WhatsApp number can't receive this message (uninstalled, blocked, or outside WhatsApp coverage).";
    case 131047:
      return 'The 24-hour reply window has expired. You need to send an approved template message to re-engage this customer.';
    case 131051:
      return 'That message type is not supported on WhatsApp yet.';
    case 190:
      return 'WhatsApp access token has expired or been revoked. Ask ops to rotate WHATSAPP_ACCESS_TOKEN.';
    default:
      return `WhatsApp send failed: ${metaMsg}`;
  }
}
