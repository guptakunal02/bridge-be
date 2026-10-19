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
  async sendText(waId: string, body: string): Promise<WhatsappSendResult> {
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
        parsed.error?.error_user_msg ||
        parsed.error?.message ||
        'Unknown error';
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
    this.logger.log(`WhatsApp send ok: wa_id=${digits} wamid=${wamid}`);
    return { wamid, raw: parsed };
  }

  /**
   * Upload media bytes to Meta's /media endpoint and return the
   * media_id. That id is the handle used in the subsequent
   * sendMedia call; Meta keeps the asset for 30 days.
   *
   * Meta's media endpoint is multipart/form-data — one `file` part
   * holding the bytes + a `messaging_product=whatsapp` field + a
   * `type=<mime>` field. We use the global `FormData` + `Blob`
   * runtime provided by undici (Node 18+) rather than pulling in a
   * polyfill.
   */
  async uploadMediaToMeta(
    body: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string> {
    const phoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/media`;

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(body)], { type: mimeType }),
      filename,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    } catch (netErr) {
      this.logger.error(
        `WhatsApp media upload network error: ${
          netErr instanceof Error ? netErr.message : String(netErr)
        }`,
      );
      throw netErr;
    }

    const text = await res.text();
    let parsed: { id?: string } & MetaErrorEnvelope;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      this.logger.error(
        `WhatsApp media upload: non-JSON response (status=${res.status}): ${text.slice(0, 500)}`,
      );
      throw new BadRequestException(
        'WhatsApp media upload failed — Meta returned an unexpected response',
      );
    }
    if (!res.ok || parsed.error || !parsed.id) {
      const code = parsed.error?.code;
      const metaMsg =
        parsed.error?.error_user_msg ||
        parsed.error?.message ||
        'Unknown error';
      this.logger.warn(
        `WhatsApp media upload rejected status=${res.status} code=${code ?? 'none'} msg="${metaMsg}"`,
      );
      throw new BadRequestException(friendlyError(code, metaMsg));
    }
    return parsed.id;
  }

  /**
   * Send a WhatsApp message carrying a previously-uploaded media
   * asset. `kind` is the Meta message type and must match the mime
   * category the media_id was uploaded under; sending an image id
   * with kind='video' fails on Meta's side with a confusing error,
   * so the caller resolves the kind from mime BEFORE calling here.
   *
   * Caption is only honored for image / video / document; audio
   * payloads ignore it (Meta drops it silently). We pass it through
   * for the supported kinds and skip for audio.
   */
  /**
   * Two-step Meta media fetch used by the inbound ingest path. Meta's
   * webhook delivers only a media_id for inbound image/video/doc/
   * audio messages; the actual bytes have to be pulled separately.
   *
   *   1. GET /{media_id} returns { url, mime_type, file_size, ... }
   *      with a short-lived download URL (5 min TTL per Meta's docs).
   *   2. GET {url} with the same Bearer auth returns the raw bytes.
   *
   * Both steps use the WHATSAPP_ACCESS_TOKEN. Failures bubble as
   * BadRequestException so the ingest can log + continue (the row
   * still gets persisted without media, and the agent sees an empty
   * bubble — much better than crashing ingestOne mid-batch).
   */
  async downloadMetaMedia(
    mediaId: string,
  ): Promise<{ body: Buffer; mime: string; size: number }> {
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });

    // Step 1 — resolve the download URL.
    const metaUrl = `https://graph.facebook.com/${version}/${mediaId}`;
    const metaRes = await fetch(metaUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const metaText = await metaRes.text();
    let metaParsed: {
      url?: string;
      mime_type?: string;
      file_size?: number;
    } & MetaErrorEnvelope;
    try {
      metaParsed = metaText ? JSON.parse(metaText) : {};
    } catch {
      throw new BadRequestException(
        'WhatsApp media fetch failed — Meta returned an unexpected response (step 1)',
      );
    }
    if (!metaRes.ok || metaParsed.error || !metaParsed.url) {
      const code = metaParsed.error?.code;
      const metaMsg =
        metaParsed.error?.error_user_msg ||
        metaParsed.error?.message ||
        'Unknown error';
      this.logger.warn(
        `WhatsApp media metadata fetch rejected media_id=${mediaId} status=${metaRes.status} code=${code ?? 'none'} msg="${metaMsg}"`,
      );
      throw new BadRequestException(friendlyError(code, metaMsg));
    }

    // Step 2 — fetch the bytes. Meta's download URL requires the
    // same Bearer token; anonymous GETs return 401.
    const bytesRes = await fetch(metaParsed.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!bytesRes.ok) {
      this.logger.warn(
        `WhatsApp media byte fetch failed media_id=${mediaId} status=${bytesRes.status}`,
      );
      throw new BadRequestException(
        'WhatsApp media fetch failed — Meta download URL returned non-2xx',
      );
    }
    const buf = Buffer.from(await bytesRes.arrayBuffer());
    return {
      body: buf,
      mime: metaParsed.mime_type ?? 'application/octet-stream',
      size: metaParsed.file_size ?? buf.length,
    };
  }

  async sendMedia(
    waId: string,
    kind: 'image' | 'video' | 'document' | 'audio',
    mediaId: string,
    caption?: string,
    filename?: string,
  ): Promise<WhatsappSendResult> {
    const digits = waId.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('Recipient wa_id missing or invalid');
    }

    const phoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const mediaPayload: Record<string, string> = { id: mediaId };
    if (caption && kind !== 'audio') mediaPayload.caption = caption;
    // Document filename — without this Meta shows "Untitled" on the
    // recipient's WhatsApp. Only honored for the document kind; images
    // and videos ignore it. Also strip the extension? No — WhatsApp
    // displays the filename as-is, extension included, which is what
    // the agent uploaded + what the recipient expects.
    if (filename && kind === 'document') mediaPayload.filename = filename;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: digits,
      type: kind,
      [kind]: mediaPayload,
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
      this.logger.error(
        `WhatsApp media send network error for wa_id=${digits}: ${
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
        `WhatsApp media send: non-JSON response (status=${res.status}): ${text.slice(0, 500)}`,
      );
      throw new BadRequestException(
        'WhatsApp send failed — Meta returned an unexpected response',
      );
    }
    if (!res.ok || parsed.error) {
      const code = parsed.error?.code;
      const metaMsg =
        parsed.error?.error_user_msg ||
        parsed.error?.message ||
        'Unknown error';
      this.logger.warn(
        `WhatsApp media send rejected status=${res.status} code=${code ?? 'none'} msg="${metaMsg}"`,
      );
      throw new BadRequestException(friendlyError(code, metaMsg));
    }
    const wamid = parsed.messages?.[0]?.id;
    if (!wamid) {
      throw new BadRequestException(
        'WhatsApp send failed — Meta did not return a message id',
      );
    }
    this.logger.log(`WhatsApp ${kind} send ok: wa_id=${digits} wamid=${wamid}`);
    return { wamid, raw: parsed };
  }

  /**
   * Send an approved template message. Templates are the ONLY path
   * to re-engage a customer once the 24h customer-service window has
   * closed — Meta rejects everything else with code 131047.
   *
   * Meta's template payload shape:
   *   type: "template",
   *   template: {
   *     name: "<template name>",
   *     language: { code: "<bcp47>" },
   *     components: [
   *       { type: "body", parameters: [{ type: "text", text: "V1" }, ...] }
   *     ]
   *   }
   *
   * V1 only ships BODY-component templates — no HEADER (image/video),
   * no BUTTONS. `variables` is the array of {{1}}, {{2}}, … values
   * in order. Empty array for static templates.
   */
  async sendTemplate(
    waId: string,
    templateName: string,
    language: string,
    variables: string[],
  ): Promise<WhatsappSendResult> {
    const digits = waId.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('Recipient wa_id missing or invalid');
    }

    const phoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const components =
      variables.length > 0
        ? [
            {
              type: 'body',
              parameters: variables.map((v) => ({
                type: 'text',
                text: v,
              })),
            },
          ]
        : [];

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: digits,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        ...(components.length > 0 ? { components } : {}),
      },
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
      this.logger.error(
        `WhatsApp template send network error for wa_id=${digits}: ${
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
        `WhatsApp template send: non-JSON response (status=${res.status}): ${text.slice(0, 500)}`,
      );
      throw new BadRequestException(
        'WhatsApp send failed — Meta returned an unexpected response',
      );
    }
    if (!res.ok || parsed.error) {
      const code = parsed.error?.code;
      const metaMsg =
        parsed.error?.error_user_msg ||
        parsed.error?.message ||
        'Unknown error';
      this.logger.warn(
        `WhatsApp template send rejected status=${res.status} code=${code ?? 'none'} template=${templateName} msg="${metaMsg}"`,
      );
      throw new BadRequestException(friendlyError(code, metaMsg));
    }
    const wamid = parsed.messages?.[0]?.id;
    if (!wamid) {
      throw new BadRequestException(
        'WhatsApp send failed — Meta did not return a message id',
      );
    }
    this.logger.log(
      `WhatsApp template send ok: wa_id=${digits} template=${templateName} wamid=${wamid}`,
    );
    return { wamid, raw: parsed };
  }
}

/**
 * Infer the Meta "message type" bucket from a mime type. Caller
 * passes the resolved kind to sendMedia AND uses it to decide which
 * message_type column value to persist. Returns null for mimes
 * WhatsApp doesn't natively accept — the caller rejects before
 * burning a Meta round-trip.
 */
export function resolveMediaKind(
  mime: string,
): 'image' | 'video' | 'document' | 'audio' | null {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/png') return 'image';
  if (m === 'video/mp4' || m === 'video/3gp' || m === 'video/3gpp')
    return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (
    m === 'application/pdf' ||
    m === 'text/plain' ||
    m.startsWith('application/vnd.ms-') ||
    m.startsWith('application/vnd.openxmlformats-officedocument') ||
    m === 'application/msword'
  ) {
    return 'document';
  }
  return null;
}

/**
 * Per-kind size caps Meta enforces at /media upload. We check locally
 * before uploading so the agent sees a clear reject instead of a
 * cryptic Meta error at the upload step. Numbers are from Meta's
 * WhatsApp Business Platform docs (as of 2026-10-15).
 */
export const WHATSAPP_MEDIA_SIZE_CAPS: Record<
  'image' | 'video' | 'document' | 'audio',
  number
> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

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
