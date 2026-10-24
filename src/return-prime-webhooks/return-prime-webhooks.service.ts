import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
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
