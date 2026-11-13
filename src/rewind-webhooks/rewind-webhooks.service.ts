import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { AutomationEngine } from '../automations/automation-engine.service';
import { AUTOMATION_EVENT } from '../automations/events';
import { TicketStatus } from '../database/enums';
import { RewindWebhookEvent } from './entities/rewind-webhook-event.entity';
import type { RewindEventDto } from './dto/rewind-event.dto';
import type { TopicStatRow } from '../shopify-webhooks/shopify-webhooks.service';

/**
 * Persists each inbound Rewind webhook + emits a typed
 * `rewind.webhook` automation event carrying the specific `event`
 * name as a filterable `eventType` field. One typed Bridge event (not
 * per-event-type) keeps the BE free of churn as Rewind evolves their
 * loyalty event taxonomy — rules filter on
 * `event.eventType equals "rewind.points_earned"` and new Rewind
 * event names ship without a Bridge deploy.
 *
 * Idempotency: Rewind's shared body shape carries no stable event id,
 * so we synthesize `webhook_id` as a sha256 over the full body.
 * Byte-identical retries dedup at INSERT time via the UNIQUE
 * constraint; distinct events get distinct ids.
 */
@Injectable()
export class RewindWebhooksService {
  private readonly logger = new Logger(RewindWebhooksService.name);

  constructor(
    @InjectRepository(RewindWebhookEvent)
    private readonly events: Repository<RewindWebhookEvent>,
    private readonly automations: AutomationEngine,
  ) {}

  async handle(dto: RewindEventDto): Promise<{ deduped: boolean }> {
    const eventName = dto.event.trim();
    const customerPhone = normalisePhone(dto.customerPhone);
    const webhookId = deriveWebhookId(dto);
    const bodyForAudit: Record<string, unknown> = {
      event: eventName,
      customerPhone: dto.customerPhone,
      channelId: dto.channelId,
      ...(dto.variables !== undefined ? { variables: dto.variables } : {}),
      ...(dto.rawPayload !== undefined ? { rawPayload: dto.rawPayload } : {}),
    };

    try {
      await this.events.save(
        this.events.create({
          webhook_id: webhookId,
          event_type: eventName,
          payload: bodyForAudit,
          customer_phone: customerPhone,
        }),
      );
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const code = (err as unknown as { driverError?: { code?: string } })
          .driverError?.code;
        if (code === '23505') {
          this.logger.log(
            `Rewind webhook dedup: id=${webhookId} event=${eventName} — skipping emit`,
          );
          return { deduped: true };
        }
      }
      throw err;
    }

    this.automations.emit({
      event: AUTOMATION_EVENT.REWIND_WEBHOOK,
      // Sentinel ticket snapshot — webhook sends are ticketless (same
      // convention as WEBHOOK_CUSTOM). Predicates key on `event.*`.
      ticket: {
        id: '',
        channelId: dto.channelId,
        channelType: null,
        status: TicketStatus.OPEN,
        tags: [],
        assigneeId: null,
        teamId: '',
        subject: null,
      },
      payload: {
        name: 'rewind.webhook',
        channelId: dto.channelId,
        customerPhone: customerPhone ?? dto.customerPhone,
        eventType: eventName,
        variables: dto.variables ?? {},
        rawPayload: dto.rawPayload,
      },
    });
    return { deduped: false };
  }

  /**
   * Aggregate the last 24h/7d/30d of received events keyed by
   * Rewind event name. Signature matches the shared TopicStatRow
   * shape so the settings controller can delegate the same way it
   * does for shopify / clickpost / lens / rp.
   */
  async topicStats(input: { since: Date }): Promise<TopicStatRow[]> {
    const rows = (await this.events
      .createQueryBuilder('e')
      .select('e.event_type', 'topic')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('MIN(e.received_at)', 'first_at')
      .addSelect('MAX(e.received_at)', 'last_at')
      .where('e.received_at >= :since', { since: input.since })
      .groupBy('e.event_type')
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
}

function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

/**
 * Synthesize a stable dedup key from the full body. Byte-identical
 * retries hash to the same value and 23505 at INSERT; distinct events
 * (even with the same phone + event name) hash to distinct values
 * because rawPayload almost always carries an event-specific id or
 * timestamp.
 */
function deriveWebhookId(dto: RewindEventDto): string {
  const seed = JSON.stringify({
    event: dto.event,
    customerPhone: dto.customerPhone,
    channelId: dto.channelId,
    variables: dto.variables ?? null,
    rawPayload: dto.rawPayload ?? null,
  });
  return `rewind:${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
