import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ReturnPrimeWebhooksService } from './return-prime-webhooks.service';

/**
 * Open endpoint for Return Prime webhooks. No HMAC / signature auth
 * because RP doesn't sign inbound POSTs (per their docs as of
 * 2026-10-23). We rely on URL obscurity for now — the admin accepted
 * this trade-off while we observe real payload shapes before
 * designing automation extraction. When RP adds signing OR when we
 * add a secret-URL guard, this controller gets a UseGuards attached.
 *
 * Expects RP's standard webhook body shape:
 *   { "topic": "...", "data": {...} }  OR
 *   { topic + full payload merged at root } — we handle both.
 *
 * Always returns 202 for a well-formed request so RP's retry queue
 * doesn't pile up on recoverable persistence hiccups (dedup still
 * writes if the row already exists; see service).
 */
@Public()
@Controller('webhooks/return-prime')
export class ReturnPrimeWebhooksController {
  private readonly logger = new Logger(ReturnPrimeWebhooksController.name);

  constructor(private readonly service: ReturnPrimeWebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Req() req: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: Record<string, unknown>,
  ): Promise<{ accepted: true; deduped: boolean }> {
    // RP sends the topic as a HEADER, not in the body — confirmed by
    // cross-checking a parallel ops-side consumer that's been receiving
    // RP events since June 2026. The exact header name isn't documented
    // but their convention is x-rp-* (same prefix as the outbound auth
    // token). Try the known candidates in order; fall back to inferring
    // from the body's request_type / refund.status if headers don't
    // reveal it. Log every unknown so we can see the actual header
    // name on the first real event that lands and refine this list.
    const headerTopic =
      asHeader(headers['x-rp-topic']) ??
      asHeader(headers['x-rp-event']) ??
      asHeader(headers['x-topic']) ??
      asHeader(headers['x-event']) ??
      asHeader(headers['x-webhook-topic']) ??
      asHeader(headers['x-webhook-event']) ??
      null;
    const bodyTopic =
      asString(body['topic']) ??
      asString(body['event']) ??
      asString(body['event_type']) ??
      asString(body['type']) ??
      null;
    // Last-ditch body-shape inference: the two sample payloads from
    // ops.teev.shop show RP's payload is identical between create and
    // refund — only `line_items[].refund.status` differs. Use that as
    // a proxy if headers were missed so we at least file into the
    // right topic bucket. Not a long-term solution; log loudly.
    const inferredTopic = inferTopicFromBody(body);
    const topic = headerTopic ?? bodyTopic ?? inferredTopic ?? 'unknown';
    if (topic === 'unknown') {
      // Capture every header name on the first unknown-topic event so
      // the next deploy can read the right one. Pm2 will have this.
      this.logger.warn(
        `RP topic unknown — logging headers for discovery. keys=${Object.keys(headers).join(',')} ua=${req.get('user-agent')}`,
      );
    } else if (!headerTopic && (bodyTopic ?? inferredTopic)) {
      this.logger.log(
        `RP topic from fallback: via=${bodyTopic ? 'body' : 'inferred'} topic=${topic}`,
      );
    }
    const result = await this.service.handle({
      topic,
      payload: body,
    });
    return { accepted: true, deduped: result.deduped };
  }
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return null;
}

function asHeader(v: string | string[] | undefined): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (Array.isArray(v) && v[0] && typeof v[0] === 'string') return v[0].trim();
  return null;
}

/**
 * Infer the RP topic from the body alone — fallback for when the
 * topic header is missed. Based on observed payloads at ops.teev.shop:
 *   - request/refunded: any line_item has refund.status === 'refunded'
 *   - request/created:  the request is freshly created (status 'requested')
 *   - everything else:  the lifecycle status at root (approved, received, …)
 * Returns null when nothing matches so the caller logs & stores unknown.
 */
function inferTopicFromBody(body: Record<string, unknown>): string | null {
  const lineItems = Array.isArray(body['line_items'])
    ? (body['line_items'] as Array<Record<string, unknown>>)
    : [];
  const hasRefunded = lineItems.some((li) => {
    const refund = li['refund'] as Record<string, unknown> | undefined;
    return asString(refund?.['status']) === 'refunded';
  });
  if (hasRefunded) return 'request/refunded';
  const status = asString(body['status']);
  if (status === 'requested') return 'request/created';
  if (status) return `request/${status}`;
  return null;
}
