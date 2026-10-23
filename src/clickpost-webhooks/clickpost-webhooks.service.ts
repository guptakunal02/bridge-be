import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { ClickpostWebhookEvent } from './entities/clickpost-webhook-event.entity';

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
  ) {}

  async handle(payload: Record<string, unknown>): Promise<{ deduped: boolean }> {
    const webhookId = this.deriveWebhookId(payload);
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
