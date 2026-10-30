import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { TicketStatus } from '../database/enums';
import { LensWebhookEvent } from './entities/lens-webhook-event.entity';
import type { TopicStatRow } from '../shopify-webhooks/shopify-webhooks.service';

/**
 * Receive-side pipeline for Lens-forwarded NDR / NPR events. Mirrors
 * Clickpost + Shopify webhook handling:
 *
 *   1. INSERT the raw payload. UNIQUE(event_id) is the idempotency
 *      guard — a retry from Lens short-circuits with 23505 and we
 *      skip re-emission. Lens's event_id doubles as its LimeChat
 *      idempotency key, so retries from either leg converge here.
 *   2. Emit the typed automation event (lens.ndr / lens.npr) with
 *      rawPayload set to the forwarded body. Admin rules bind to
 *      arbitrary JSON paths in the automation editor; the
 *      send_whatsapp_template handler resolves them at fire time.
 *
 * Fire-and-forget semantics on emission — handler failures never
 * block the HTTP response to Lens, which already treats us as
 * fire-and-forget on its side.
 */
@Injectable()
export class LensWebhooksService {
  private readonly logger = new Logger(LensWebhooksService.name);

  constructor(
    @InjectRepository(LensWebhookEvent)
    private readonly events: Repository<LensWebhookEvent>,
    private readonly automations: AutomationEngine,
  ) {}

  async handle(input: {
    topic: 'ndr' | 'npr' | 'rto';
    event_id: string;
    received_at?: string;
    payload: Record<string, unknown>;
  }): Promise<{ deduped: boolean }> {
    const customerPhone = extractCustomerPhoneFromLensPayload(input.payload);
    try {
      await this.events.save(
        this.events.create({
          event_id: input.event_id,
          topic: input.topic,
          payload: input.payload,
          customer_phone: customerPhone,
        }),
      );
    } catch (err) {
      // Postgres 23505 = unique_violation = Lens retried.
      if (err instanceof QueryFailedError) {
        const code = (err as unknown as { driverError?: { code?: string } })
          .driverError?.code;
        if (code === '23505') {
          this.logger.log(
            `lens webhook dedup: event_id=${input.event_id} topic=${input.topic} already seen; skipping emit`,
          );
          return { deduped: true };
        }
      }
      throw err;
    }

    this.emit(input);
    return { deduped: false };
  }

  private emit(input: {
    topic: 'ndr' | 'npr' | 'rto';
    event_id: string;
    payload: Record<string, unknown>;
  }): void {
    const event =
      input.topic === 'ndr'
        ? AUTOMATION_EVENT.LENS_NDR
        : input.topic === 'npr'
          ? AUTOMATION_EVENT.LENS_NPR
          : AUTOMATION_EVENT.LENS_RTO;
    const name: 'lens.ndr' | 'lens.npr' | 'lens.rto' =
      input.topic === 'ndr'
        ? 'lens.ndr'
        : input.topic === 'npr'
          ? 'lens.npr'
          : 'lens.rto';

    this.automations.emit({
      // Sentinel ticket — channel-less event. Rule evaluator bypasses
      // channel scoping when channelType is null (same convention as
      // Shopify + webhook.custom).
      event,
      ticket: {
        id: '',
        channelId: '',
        channelType: null,
        status: TicketStatus.OPEN,
        tags: [],
        assigneeId: null,
        teamId: '',
        subject: null,
      },
      payload: {
        name,
        // channelId empty = handler uses the template's bound channel.
        channelId: '',
        // Hoist phone_number from the Lens payload so admin rules can
        // bind recipient_phone_path to `event.customerPhone` uniformly
        // across every typed event — same path works for Shopify / RP /
        // Lens. Falls back to '' when the forwarded body lacks it;
        // admin's rule skips sends with an empty phone.
        customerPhone: extractCustomerPhoneFromLensPayload(input.payload) ?? '',
        variables: {},
        rawPayload: input.payload,
      },
    });
    this.logger.log(
      `lens ${name} emitted: event_id=${input.event_id}`,
    );
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

  /** Per-topic stats within a sliding window — see shopify.topicStats. */
  async topicStats(input: { since: Date }): Promise<TopicStatRow[]> {
    const rows = (await this.events
      .createQueryBuilder('e')
      .select('e.topic', 'topic')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('MIN(e.received_at)', 'first_at')
      .addSelect('MAX(e.received_at)', 'last_at')
      .where('e.received_at >= :since', { since: input.since })
      .groupBy('e.topic')
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

  /**
   * Chronological descending page for the Events inspector, matching
   * the shape used by shopify / clickpost / return-prime services.
   * Caller requests limit+1 for next-page detection.
   */
  async listRecent(input: {
    before: Date | null;
    limit: number;
    phone?: string | null;
    topic?: string | null;
  }): Promise<LensWebhookEvent[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .orderBy('e.received_at', 'DESC')
      .limit(input.limit);
    if (input.before) {
      qb.andWhere('e.received_at < :before', { before: input.before });
    }
    if (input.phone && input.phone.trim().length > 0) {
      qb.andWhere('e.customer_phone ILIKE :phone', {
        phone: `%${input.phone.trim()}%`,
      });
    }
    if (input.topic && input.topic.trim().length > 0) {
      qb.andWhere('e.topic ILIKE :topic', { topic: `%${input.topic.trim()}%` });
    }
    return qb.getMany();
  }
}

/**
 * Lens-forwarded Clickpost payloads carry the customer phone on
 * top-level `phone_number`. Normalise to digits-only wa_id format so
 * the Phone column + search behave consistently with other platforms.
 */
function extractCustomerPhoneFromLensPayload(
  payload: Record<string, unknown>,
): string | null {
  const raw = payload['phone_number'];
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}
