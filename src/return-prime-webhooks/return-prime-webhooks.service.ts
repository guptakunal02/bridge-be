import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { TicketStatus } from '../database/enums';
import { ReturnPrimeWebhookEvent } from './entities/return-prime-webhook-event.entity';

/**
 * Receives + persists Return Prime webhooks. No field extraction or
 * automation emission yet — this ships deliberately minimal so we can
 * observe real payload shapes in the Events inspector before writing
 * extractors. RP's docs never show an inbound payload example and
 * guessing fields leads to brittle code.
 *
 * Idempotency: RP doesn't send a dedicated event-id header. We derive
 * one from the body (topic + request id + updatedAt where available)
 * and fall back to a hash of the raw body if the payload lacks those
 * fields. UNIQUE on webhook_id then catches retries at insert time.
 */
@Injectable()
export class ReturnPrimeWebhooksService {
  private readonly logger = new Logger(ReturnPrimeWebhooksService.name);

  constructor(
    @InjectRepository(ReturnPrimeWebhookEvent)
    private readonly events: Repository<ReturnPrimeWebhookEvent>,
    @Inject(forwardRef(() => AutomationEngine))
    private readonly automations: AutomationEngine,
  ) {}

  async handle(input: {
    topic: string;
    payload: Record<string, unknown>;
  }): Promise<{ deduped: boolean }> {
    const webhookId = this.deriveWebhookId(input.topic, input.payload);
    try {
      await this.events.save(
        this.events.create({
          webhook_id: webhookId,
          topic: input.topic,
          payload: input.payload,
        }),
      );
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const code = (err as unknown as { driverError?: { code?: string } })
          .driverError?.code;
        if (code === '23505') {
          this.logger.log(
            `return prime webhook dedup: webhook_id=${webhookId} already seen; skipping`,
          );
          return { deduped: true };
        }
      }
      throw err;
    }
    this.logger.log(
      `return prime webhook received: topic="${input.topic}" webhook_id=${webhookId}`,
    );
    this.emit(input.topic, input.payload);
    return { deduped: false };
  }

  /**
   * Fan the stored webhook out as a typed automation event, if the
   * topic maps to one. Dispatch runs ONLY after the dedup insert
   * succeeds, so a retried fire never re-emits. Unknown topics
   * (anything surma-ops's forwarder expands to beyond created/
   * refunded, or future RP topics) land in the audit table but don't
   * emit — admins can see them in the Events inspector + file a
   * request to typify.
   */
  private emit(topic: string, payload: Record<string, unknown>): void {
    const sentinelTicket = {
      id: '',
      channelId: '',
      channelType: null,
      status: TicketStatus.OPEN,
      tags: [],
      assigneeId: null,
      teamId: '',
      subject: null,
    };
    const customer = payload['customer'] as
      | Record<string, unknown>
      | undefined;
    const customerPhone = normalisePhone(asString(customer?.['phone']));
    const customerEmail = asString(customer?.['email']);
    const orderName =
      asString(payload['order_name']) ??
      asString(payload['orderName']) ??
      null;
    const returnRequestId =
      asString(payload['id']) ??
      asString(payload['_id']) ??
      asString(payload['request_id']) ??
      '';

    if (topic === 'request/created') {
      if (!customerPhone) {
        this.logger.warn(
          `return_prime.request.created: no customer.phone in payload for return=${returnRequestId}; emitting anyway, admin's rule will skip`,
        );
      }
      this.automations.emit({
        event: AUTOMATION_EVENT.RETURN_PRIME_REQUEST_CREATED,
        ticket: sentinelTicket,
        payload: {
          name: 'return_prime.request.created',
          channelId: '',
          customerPhone: customerPhone ?? '',
          customerEmail,
          orderName,
          returnRequestId,
          variables: {
            order_name: orderName ?? '',
            return_request_id: returnRequestId,
          },
          rawPayload: payload,
        },
      });
      return;
    }
    if (topic === 'request/refunded') {
      const refunded = extractFirstRefundedLineItem(payload);
      const refundAmount = refunded?.amount ?? null;
      const refundMode = refunded?.mode ?? null;
      if (!customerPhone) {
        this.logger.warn(
          `return_prime.request.refunded: no customer.phone in payload for return=${returnRequestId}; emitting anyway, admin's rule will skip`,
        );
      }
      this.automations.emit({
        event: AUTOMATION_EVENT.RETURN_PRIME_REQUEST_REFUNDED,
        ticket: sentinelTicket,
        payload: {
          name: 'return_prime.request.refunded',
          channelId: '',
          customerPhone: customerPhone ?? '',
          customerEmail,
          orderName,
          returnRequestId,
          refundAmount,
          refundMode,
          variables: {
            order_name: orderName ?? '',
            return_request_id: returnRequestId,
            refund_amount: refundAmount ?? '',
            refund_mode: refundMode ?? '',
          },
          rawPayload: payload,
        },
      });
      return;
    }
    // Unknown topics (request/approved, request/received, etc.) land
    // in the audit table but don't emit yet. If surma-ops adds them
    // to the forwarder whitelist later, we'd handle each here in the
    // same shape.
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
   * Chronological descending page for the Events inspector. Keyset
   * via (received_at < before); caller requests `limit + 1` and uses
   * the last row's received_at as `nextBefore`.
   */
  async listRecent(input: {
    before: Date | null;
    limit: number;
  }): Promise<ReturnPrimeWebhookEvent[]> {
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
   * Build a stable idempotency key for this webhook. Based on
   * confirmed payloads at the ops.teev.shop RP consumer:
   *   - `id` is RP's internal request id (e.g. `6adc52fc...`)
   *   - `updated_at` bumps on every mutation (approved → received →
   *     refunded, etc.)
   * Together they're unique per request per state transition — a
   * retry of the same transition has identical both, dedups cleanly.
   * `topic` prefix keeps separate event types independent (same
   * request firing both created + refunded gets 2 rows, correctly).
   * Hash fallback preserves dedup even when fields are missing.
   */
  private deriveWebhookId(
    topic: string,
    payload: Record<string, unknown>,
  ): string {
    const requestId =
      asString(payload['id']) ??
      asString(payload['_id']) ??
      asString(payload['request_id']) ??
      asString((payload['request'] as Record<string, unknown>)?.['_id']) ??
      asString((payload['request'] as Record<string, unknown>)?.['id']) ??
      null;
    const updatedAt =
      asString(payload['updated_at']) ??
      asString(payload['updatedAt']) ??
      asString(
        (payload['request'] as Record<string, unknown>)?.['updatedAt'],
      ) ??
      null;
    if (requestId) {
      return `${topic}:${requestId}:${updatedAt ?? ''}`;
    }
    const hash = createHash('sha256')
      .update(topic)
      .update('|')
      .update(JSON.stringify(payload))
      .digest('hex');
    return `${topic}:hash:${hash}`;
  }
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Normalise RP's `customer.phone` to a plain-digit wa_id. RP sends
 * E.164 with the leading `+` (confirmed by surma-ops's 2026-10-29 DB
 * check — 98.6% coverage, every row is `+<country><digits>`). The
 * Meta send API accepts both forms, but keeping normalisation here
 * means the handler log line + any downstream dedup sees the same
 * canonical shape.
 */
function normalisePhone(v: string | null): string | null {
  if (!v) return null;
  const digits = v.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * Pulls refund amount + mode from the FIRST line item that's been
 * marked refunded. Multi-item refunds in one webhook (same request,
 * all items refunded at once) have identical refund.actual_mode
 * across items in practice — surma-ops's 25k-row DB check didn't
 * surface a split-mode case. We hoist the first value as the rule's
 * discriminator; admins who care about per-item precision can bind
 * `rawPayload.line_items[0].refund.*` directly.
 */
function extractFirstRefundedLineItem(
  payload: Record<string, unknown>,
): { amount: string | null; mode: string | null } | null {
  const lineItems = Array.isArray(payload['line_items'])
    ? (payload['line_items'] as Array<Record<string, unknown>>)
    : [];
  for (const li of lineItems) {
    const refund = li['refund'] as Record<string, unknown> | undefined;
    if (!refund) continue;
    if (asString(refund['status']) !== 'refunded') continue;
    const amountNode = refund['refunded_amount'] as
      | Record<string, unknown>
      | undefined;
    const shopMoney = amountNode?.['shop_money'] as
      | Record<string, unknown>
      | undefined;
    const amount = asString(shopMoney?.['amount']);
    const mode = asString(refund['actual_mode']);
    return { amount, mode };
  }
  return null;
}
