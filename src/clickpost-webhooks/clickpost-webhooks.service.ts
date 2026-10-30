import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import type { EnvVars } from '../config/env.validation';
import { ClickpostWebhookEvent } from './entities/clickpost-webhook-event.entity';
import type { TopicStatRow } from '../shopify-webhooks/shopify-webhooks.service';

/** Cap on the surma-ops enrichment hop. Cache-hit is ~5ms per
 *  surma-ops's 2026-10-30 measurement; 2s leaves plenty of headroom
 *  to drop enrichment rather than block the webhook ACK. */
const SURMA_OPS_CONTACT_FETCH_TIMEOUT_MS = 2000;

/**
 * Receives + persists Clickpost tracking webhooks. No field extraction
 * or automation emission yet — scoping scaffolding so we can observe
 * real OFD / Delivered payloads in the Events inspector before writing
 * extractors. Clickpost's status taxonomy is wide and dependent on the
 * admin's selected-checkpoints choice; guessing fields leads to
 * brittle code.
 *
 * Idempotency: Clickpost retries on non-200 and doesn't send a
 * dedicated event id. We derive one from
 *   (waybill + clickpost_status_code + timestamp)
 * which is unique per shipment per status per scan. Falls back to a
 * sha256 of the raw body when any of those are absent. UNIQUE on
 * webhook_id catches retries at insert time; no race window.
 */
@Injectable()
export class ClickpostWebhooksService {
  private readonly logger = new Logger(ClickpostWebhooksService.name);

  constructor(
    @InjectRepository(ClickpostWebhookEvent)
    private readonly events: Repository<ClickpostWebhookEvent>,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  async handle(payload: Record<string, unknown>): Promise<{ deduped: boolean }> {
    const webhookId = this.deriveWebhookId(payload);
    // Un-mask the Clickpost PII BEFORE persistence so the stored row,
    // the FE event-sample JSON tree, and any downstream automation
    // event all see the same enriched shape. Clickpost's enterprise
    // plan redacts customer phone / email / name to "**********" with
    // no toggle; surma-ops has the real contact on the parent Shopify
    // order. Mutates payload in-place; silent no-op on any failure.
    await this.enrichMaskedContact(payload, webhookId);
    const status = asString(payload['status']) ?? 'unknown';
    const waybill = asString(payload['waybill']);
    const additional = payload['additional'] as
      | Record<string, unknown>
      | undefined;
    const orderId = asString(additional?.['order_id']);
    try {
      await this.events.save(
        this.events.create({
          webhook_id: webhookId,
          status,
          waybill,
          order_id: orderId,
          payload,
        }),
      );
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const code = (err as unknown as { driverError?: { code?: string } })
          .driverError?.code;
        if (code === '23505') {
          this.logger.log(
            `clickpost webhook dedup: webhook_id=${webhookId} already seen; skipping`,
          );
          return { deduped: true };
        }
      }
      throw err;
    }
    this.logger.log(
      `clickpost webhook received: status="${status}" waybill=${waybill ?? 'null'} order=${orderId ?? 'null'}`,
    );
    return { deduped: false };
  }

  /** Most-recent received_at for the Integrations page's "last event". */
  async lastEventAt(): Promise<Date | null> {
    const row = await this.events.findOne({
      where: {},
      order: { received_at: 'DESC' },
      select: { received_at: true },
    });
    return row?.received_at ?? null;
  }

  /**
   * Per-status stats within a sliding window. Clickpost uses `status`
   * as the natural event-type (OFD / Delivered / etc.) — same role as
   * `topic` on other platforms.
   */
  async topicStats(input: { since: Date }): Promise<TopicStatRow[]> {
    const rows = (await this.events
      .createQueryBuilder('e')
      .select('e.status', 'topic')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('MIN(e.received_at)', 'first_at')
      .addSelect('MAX(e.received_at)', 'last_at')
      .where('e.received_at >= :since', { since: input.since })
      .groupBy('e.status')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany()) as Array<{
      topic: string;
      count: number;
      first_at: Date;
      last_at: Date;
    }>;
    return rows.map((r) => ({
      topic: r.topic,
      count: r.count,
      firstAt: r.first_at.toISOString(),
      lastAt: r.last_at.toISOString(),
    }));
  }

  async listRecent(input: {
    before: Date | null;
    limit: number;
  }): Promise<ClickpostWebhookEvent[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .orderBy('e.received_at', 'DESC')
      .limit(input.limit);
    if (input.before) {
      qb.andWhere('e.received_at < :before', { before: input.before });
    }
    return qb.getMany();
  }

  /**
   * Look up the real customer contact for this Clickpost webhook via
   * surma-ops and overwrite the masked fields in-place. Payload shape
   * before (from Clickpost):
   *   additional: { phone: "**********", email: "**********", name: "**********", order_id: "242084", … }
   * Payload shape after a successful lookup:
   *   additional: { phone: "919821697002", email: "payal@…", name: "Payal thakkar", order_id: "242084", … }
   *   enrichments: { contact_source: "surma_ops_lookup" }
   *
   * Fully best-effort. On any failure (env unset, secret missing, no
   * order_id in payload, surma-ops 404 / 5xx / timeout, malformed
   * response) we leave the masks in place and move on. The admin's
   * automation rule will see the empty phone and skip; same cost as
   * doing nothing.
   */
  private async enrichMaskedContact(
    payload: Record<string, unknown>,
    webhookId: string,
  ): Promise<void> {
    const baseUrl = this.config.get('LENS_CUSTOMER_CONTACT_URL', {
      infer: true,
    });
    const secret = this.config.get('LENS_INTERNAL_SECRET', { infer: true });
    if (!baseUrl || !secret) return;
    const additional = payload['additional'] as
      | Record<string, unknown>
      | undefined;
    if (!additional) return;
    const orderId = asString(additional['order_id']);
    if (!orderId) {
      this.logger.log(
        `clickpost enrich: webhook_id=${webhookId} no additional.order_id — skipping`,
      );
      return;
    }
    const url =
      `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(orderId)}` +
      `/customer-contact`;
    const ac = new AbortController();
    const t = setTimeout(
      () => ac.abort(),
      SURMA_OPS_CONTACT_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': secret },
        signal: ac.signal,
      });
      if (res.status === 404) {
        this.logger.log(
          `clickpost enrich: webhook_id=${webhookId} order=${orderId} not found in surma-ops — leaving masks in place`,
        );
        return;
      }
      if (!res.ok) {
        this.logger.warn(
          `clickpost enrich: webhook_id=${webhookId} order=${orderId} returned ${res.status} — leaving masks`,
        );
        return;
      }
      const body = (await res.json()) as {
        customer_phone?: string | null;
        customer_email?: string | null;
        customer_first_name?: string | null;
        customer_last_name?: string | null;
      };
      // Overwrite ONLY the fields surma-ops actually returned a value
      // for — a null phone (COD-manual order without captured phone)
      // leaves the "**********" mask in place rather than wiping it,
      // which keeps the shape distinguishable from "we never tried
      // enrichment" (where enrichments.contact_source wouldn't be set).
      if (body.customer_phone) additional['phone'] = body.customer_phone;
      if (body.customer_email) additional['email'] = body.customer_email;
      const fullName = [body.customer_first_name, body.customer_last_name]
        .filter((p): p is string => Boolean(p && p.trim().length > 0))
        .join(' ')
        .trim();
      if (fullName) additional['name'] = fullName;
      const existing =
        (payload['enrichments'] as Record<string, unknown> | undefined) ?? {};
      existing['contact_source'] = 'surma_ops_lookup';
      payload['enrichments'] = existing;
      this.logger.log(
        `clickpost enrich: webhook_id=${webhookId} order=${orderId} unmasked phone=${body.customer_phone ? 'yes' : 'no'} email=${body.customer_email ? 'yes' : 'no'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `clickpost enrich: webhook_id=${webhookId} order=${orderId} lookup failed: ${msg} — leaving masks`,
      );
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Natural key: (waybill, clickpost_status_code, timestamp). Same
   * shipment + same status code + same scan time ≡ same event. Falls
   * back to a hash of the raw body when any key component is missing.
   */
  private deriveWebhookId(payload: Record<string, unknown>): string {
    const waybill = asString(payload['waybill']);
    const codeRaw = payload['clickpost_status_code'];
    const code =
      typeof codeRaw === 'number'
        ? String(codeRaw)
        : asString(codeRaw);
    const timestamp = asString(payload['timestamp']);
    if (waybill && code && timestamp) {
      return `${waybill}:${code}:${timestamp}`;
    }
    const hash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    return `hash:${hash}`;
  }
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
