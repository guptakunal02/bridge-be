import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
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
  constructor(private readonly service: ReturnPrimeWebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Body() body: Record<string, unknown>,
  ): Promise<{ accepted: true; deduped: boolean }> {
    // RP's payload shape is undocumented. Common envelope patterns:
    //   { topic: "...", data: {...} }
    //   { event: "...", data: {...} }
    //   { ...fields, event_type: "..." }
    // Try the known key names; fall back to "unknown" so the row
    // still lands in the audit log — we can inspect and refine.
    const topic =
      asString(body['topic']) ??
      asString(body['event']) ??
      asString(body['event_type']) ??
      asString(body['type']) ??
      'unknown';
    if (!topic || topic === 'unknown') {
      // Still persist the raw body — we need the sample to figure out
      // RP's actual envelope. BadRequest here would discard it.
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
