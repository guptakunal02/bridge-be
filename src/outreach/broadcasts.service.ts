import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  BroadcastRecipientStatus,
  BroadcastStatus,
  WhatsappTemplateCategory,
} from '../database/enums';
import { WhatsappTemplate } from '../whatsapp-inbox/entities/whatsapp-template.entity';
import { extractVariableReferences } from '../whatsapp-inbox/template-variables';
import { Broadcast } from './entities/broadcast.entity';
import { BroadcastRecipient } from './entities/broadcast-recipient.entity';
import { BroadcastWorkerService } from './broadcast-worker.service';
import { Segment } from './entities/segment.entity';

export interface BroadcastDetail {
  id: string;
  name: string;
  segment_id: string;
  template_id: string;
  channel_id: string | null;
  status: BroadcastStatus;
  scheduled_for: Date | null;
  max_tries: number;
  retry_window_minutes: number;
  header_image_url_override: string | null;
  per_message_bid_multiplier: number | null;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  pending_count: number;
  created_by: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

/**
 * Marketing broadcast lifecycle: snapshot a (segment × template)
 * audience at create time, hand it to the worker on start, surface
 * progress + per-recipient status to the admin UI.
 *
 * The snapshot step is the heart of the design. We resolve each
 * recipient's template fill values from Customer fields IMMEDIATELY
 * so the broadcast's audience is frozen from the moment of
 * creation. Late CSV re-uploads, late STOP flips, late template
 * edits don't retroactively mutate an in-flight (or
 * about-to-start) broadcast. The downside is admin can't edit a
 * template between create and start; the upside is predictability.
 */
@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    @InjectRepository(Broadcast)
    private readonly broadcasts: Repository<Broadcast>,
    @InjectRepository(BroadcastRecipient)
    private readonly recipients: Repository<BroadcastRecipient>,
    @InjectRepository(Segment)
    private readonly segments: Repository<Segment>,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => BroadcastWorkerService))
    private readonly worker: BroadcastWorkerService,
  ) {}

  async create(
    createdBy: string,
    input: {
      name: string;
      segmentId: string;
      templateId: string;
      scheduledFor?: string;
      maxTries?: number;
      retryWindowMinutes?: number;
      headerImageUrlOverride?: string;
      perMessageBidMultiplier?: number;
    },
  ): Promise<Broadcast> {
    const segment = await this.segments.findOne({
      where: { id: input.segmentId },
    });
    if (!segment) throw new NotFoundException('Segment not found');

    const template = await this.templates.findOne({
      where: { id: input.templateId },
    });
    if (!template) throw new NotFoundException('Template not found');
    if (template.category !== WhatsappTemplateCategory.MARKETING) {
      throw new BadRequestException(
        'Only MARKETING templates can be used in a broadcast',
      );
    }
    if (template.status !== 'APPROVED') {
      throw new BadRequestException(
        `Template "${template.name}" is ${template.status}, not APPROVED — broadcasts need an approved template`,
      );
    }

    // Schema-compat check — the single most load-bearing invariant
    // of the segment-vs-template model. Template references like
    // {{first_name}} must be a subset of the fields the segment
    // mapped at CSV upload time; otherwise some recipients would
    // have NULL for a required variable and Meta would reject.
    const refs = extractVariableReferences(template.body);
    const missing = refs.filter(
      (name) => !segment.mappedFields.includes(name),
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Template "${template.name}" references {{${missing.join('}}, {{')}}} ` +
          `but segment "${segment.name}" didn't map ${missing.join(', ')} at upload. ` +
          `Either re-upload the segment with those columns mapped, or ` +
          `pick a template that doesn't use them.`,
      );
    }

    // Snapshot recipients: (segment members) ∩ (NOT marketing_opted_out).
    // Done inside a transaction with the broadcast insert so a
    // concurrent STOP mid-snapshot doesn't produce a half-filtered
    // audience.
    return this.dataSource.transaction(async (mgr) => {
      const broadcast = await mgr.getRepository(Broadcast).save(
        mgr.getRepository(Broadcast).create({
          name: input.name.trim(),
          segment_id: input.segmentId,
          template_id: input.templateId,
          channel_id: template.channelId,
          status: BroadcastStatus.DRAFT,
          scheduled_for: input.scheduledFor
            ? new Date(input.scheduledFor)
            : null,
          max_tries: input.maxTries ?? 3,
          retry_window_minutes: input.retryWindowMinutes ?? 60,
          header_image_url_override: input.headerImageUrlOverride ?? null,
          per_message_bid_multiplier:
            typeof input.perMessageBidMultiplier === 'number'
              ? String(input.perMessageBidMultiplier)
              : null,
          created_by: createdBy,
        }),
      );

      // Pull the audience + resolve variables in one SQL round-trip.
      // The template's variableMapping is an ORDERED list — Meta's
      // send API expects positional parameters, so we iterate the
      // mapping in order and read the corresponding Customer field.
      const mappingOrder = (template.variableMapping ?? []).map((m) => m.name);
      // SELECT only the fields we need, filter opt-out server-side.
      const members: Array<{
        id: string;
        phone: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
      }> = await mgr.query(
        `
        SELECT c.id, c.phone, c.first_name, c.last_name, c.email
        FROM segment_customer sc
        JOIN customer c ON c.id = sc.customer_id
        WHERE sc.segment_id = $1
          AND c.marketing_opted_out = false
          AND c.phone IS NOT NULL AND length(c.phone) >= 10
      `,
        [input.segmentId],
      );

      if (members.length === 0) {
        // Zero-recipient broadcasts are allowed to create (admin
        // might want to inspect the empty state); start() will
        // skip the worker and transition straight to COMPLETED.
        await mgr.getRepository(Broadcast).update(broadcast.id, {
          total_recipients: 0,
        });
        return broadcast;
      }

      const recipientRows = members.map((m) => {
        const resolved = mappingOrder.map((name) => {
          if (name === 'first_name') return m.first_name;
          if (name === 'last_name') return m.last_name;
          if (name === 'email') return m.email;
          return null; // unknown variable — sender uses fallback
        });
        return {
          broadcast_id: broadcast.id,
          customer_id: m.id,
          phone: m.phone,
          variables_resolved: resolved,
        };
      });
      // Bulk insert — chunked to stay under PG_MAX_PARAMS. 4 cols/
      // row => 16k rows per chunk at the 65535 limit; we use 5k for
      // comfortable headroom.
      const CHUNK = 5_000;
      for (let i = 0; i < recipientRows.length; i += CHUNK) {
        await mgr
          .getRepository(BroadcastRecipient)
          .createQueryBuilder()
          .insert()
          .values(recipientRows.slice(i, i + CHUNK))
          .execute();
      }
      await mgr.getRepository(Broadcast).update(broadcast.id, {
        total_recipients: recipientRows.length,
      });

      this.logger.log(
        `Broadcast ${broadcast.id} created: segment=${segment.name} template=${template.name} recipients=${recipientRows.length}`,
      );
      return (await mgr
        .getRepository(Broadcast)
        .findOne({ where: { id: broadcast.id } }))!;
    });
  }

  async list(): Promise<Broadcast[]> {
    return this.broadcasts.find({ order: { createdAt: 'DESC' } });
  }

  async getDetail(id: string): Promise<BroadcastDetail> {
    const b = await this.broadcasts.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Broadcast not found');
    // pending = total − (sent + delivered + read + failed) is cheaper
    // than COUNT; sent/delivered/read are mutually exclusive terminal
    // states for the per-row status column so no double-counting.
    const pending =
      b.total_recipients -
      b.sent_count -
      b.delivered_count -
      b.read_count -
      b.failed_count;
    return {
      id: b.id,
      name: b.name,
      segment_id: b.segment_id,
      template_id: b.template_id,
      channel_id: b.channel_id,
      status: b.status,
      scheduled_for: b.scheduled_for,
      max_tries: b.max_tries,
      retry_window_minutes: b.retry_window_minutes,
      header_image_url_override: b.header_image_url_override,
      per_message_bid_multiplier:
        b.per_message_bid_multiplier !== null
          ? Number(b.per_message_bid_multiplier)
          : null,
      total_recipients: b.total_recipients,
      sent_count: b.sent_count,
      delivered_count: b.delivered_count,
      read_count: b.read_count,
      failed_count: b.failed_count,
      pending_count: Math.max(0, pending),
      created_by: b.created_by,
      error: b.error,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      started_at: b.started_at,
      completed_at: b.completed_at,
    };
  }

  async start(id: string): Promise<Broadcast> {
    const b = await this.broadcasts.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Broadcast not found');
    if (b.status !== BroadcastStatus.DRAFT) {
      throw new BadRequestException(
        `Broadcast is ${b.status} — only DRAFT broadcasts can start`,
      );
    }
    if (b.total_recipients === 0) {
      await this.broadcasts.update(id, {
        status: BroadcastStatus.COMPLETED,
        started_at: new Date(),
        completed_at: new Date(),
      });
      return (await this.broadcasts.findOne({ where: { id } }))!;
    }
    await this.broadcasts.update(id, {
      status: BroadcastStatus.SENDING,
      started_at: new Date(),
    });
    // Kick worker — fire-and-forget. Worker owns its error handling.
    setImmediate(() => {
      void this.worker.run(id).catch((err) => {
        this.logger.error(
          `broadcast ${id} worker crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    return (await this.broadcasts.findOne({ where: { id } }))!;
  }

  async cancel(id: string): Promise<Broadcast> {
    const b = await this.broadcasts.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Broadcast not found');
    if (
      b.status !== BroadcastStatus.SENDING &&
      b.status !== BroadcastStatus.DRAFT
    ) {
      throw new BadRequestException(
        `Can only cancel DRAFT or SENDING broadcasts, not ${b.status}`,
      );
    }
    // Worker checks this field between batches and bails out.
    await this.broadcasts.update(id, {
      status: BroadcastStatus.CANCELLED,
      completed_at: new Date(),
    });
    return (await this.broadcasts.findOne({ where: { id } }))!;
  }

  async listRecipients(
    broadcastId: string,
    limit: number,
    offset: number,
    status?: BroadcastRecipientStatus,
  ): Promise<{ rows: BroadcastRecipient[]; total: number }> {
    const where: {
      broadcast_id: string;
      status?: BroadcastRecipientStatus;
    } = { broadcast_id: broadcastId };
    if (status) where.status = status;
    const [rows, total] = await this.recipients.findAndCount({
      where,
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
    return { rows, total };
  }
}
