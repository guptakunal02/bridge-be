import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BroadcastRecipientStatus,
  BroadcastStatus,
} from '../database/enums';
import { WhatsappTemplate } from '../whatsapp-inbox/entities/whatsapp-template.entity';
import { WhatsappSenderService } from '../whatsapp-inbox/whatsapp-sender.service';
import { Broadcast } from './entities/broadcast.entity';
import { BroadcastRecipient } from './entities/broadcast-recipient.entity';

/**
 * How many recipients we fire concurrently per tick. 100 is well
 * under Meta's documented ~250 msg/s ceiling for a verified phone
 * number — leaves headroom for in-flight automation sends and
 * agent replies that share the same quota.
 */
const BATCH_SIZE = 100;

/**
 * Between-batch delay. The ceiling is Meta's rate limit; we're
 * conservative to avoid 429s. 1 second pacing + 100-per-batch =
 * ~100 msg/s theoretical throughput, which is safe. If broadcasts
 * routinely need faster throughput we can tune up with telemetry.
 */
const BETWEEN_BATCH_DELAY_MS = 1_000;

/**
 * Per-send retry base — multiplied by `attempts` for exponential-ish
 * backoff. First retry after 2s, second after 4s. Lower than the
 * broadcast's retry_window to leave room for the per-recipient
 * flow to actually complete.
 */
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Processes a broadcast end-to-end: iterate PENDING recipients in
 * batches, fire template sends concurrently per batch, update
 * per-recipient status + the Broadcast aggregates, respect cancel.
 *
 * Resumption: on module init, mark any SENDING-but-no-worker
 * broadcasts as FAILED (the process restart drops the worker; a
 * SENDING row without an active worker is lost). V2 can resume
 * via a redis-backed queue; V1 keeps it simple.
 */
@Injectable()
export class BroadcastWorkerService implements OnModuleInit {
  private readonly logger = new Logger(BroadcastWorkerService.name);

  constructor(
    @InjectRepository(Broadcast)
    private readonly broadcasts: Repository<Broadcast>,
    @InjectRepository(BroadcastRecipient)
    private readonly recipients: Repository<BroadcastRecipient>,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    private readonly sender: WhatsappSenderService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Clean up SENDING rows left behind by a prior-process restart.
    // Admin can create a new broadcast referencing the same segment +
    // template to retry; attempting to resume a SENDING-interrupted
    // row from the middle risks duplicates (Meta already-sent-this-
    // recipient check would help but Meta charges per send regardless).
    const orphans = await this.broadcasts.find({
      where: { status: BroadcastStatus.SENDING },
    });
    for (const b of orphans) {
      this.logger.warn(
        `Broadcast ${b.id} was SENDING at startup — marking FAILED, admin should retry`,
      );
      await this.broadcasts.update(b.id, {
        status: BroadcastStatus.FAILED,
        error: 'Process restarted mid-send; create a new broadcast to retry',
        completed_at: new Date(),
      });
    }
  }

  async run(broadcastId: string): Promise<void> {
    const broadcast = await this.broadcasts.findOne({
      where: { id: broadcastId },
    });
    if (!broadcast) {
      this.logger.error(`run: broadcast ${broadcastId} vanished`);
      return;
    }
    const template = await this.templates.findOne({
      where: { id: broadcast.template_id },
    });
    if (!template) {
      await this.broadcasts.update(broadcastId, {
        status: BroadcastStatus.FAILED,
        error: 'Template deleted between create and start',
        completed_at: new Date(),
      });
      return;
    }

    const headerImageUrl =
      broadcast.header_image_url_override ?? template.headerMediaUrl;

    this.logger.log(
      `Broadcast ${broadcastId} starting: total=${broadcast.total_recipients} template=${template.name}`,
    );

    let processedAny = false;
    while (true) {
      const batch = await this.recipients.find({
        where: {
          broadcast_id: broadcastId,
          status: BroadcastRecipientStatus.PENDING,
        },
        take: BATCH_SIZE,
        order: { createdAt: 'ASC' },
      });
      if (batch.length === 0) break;
      processedAny = true;

      // Fire in parallel per batch — fine for I/O-bound Meta calls.
      await Promise.all(
        batch.map((r) =>
          this.sendOne(r, broadcast, template, headerImageUrl),
        ),
      );

      // Reconcile aggregate counters after each batch so the admin
      // UI's polling sees fresh numbers without GROUP BY'ing N
      // million rows every 3s.
      await this.reconcileCounters(broadcastId);

      // Cancel check — polls the latest status column; if admin
      // cancelled mid-run, stop here (remaining rows stay PENDING).
      const latest = await this.broadcasts.findOne({
        where: { id: broadcastId },
      });
      if (!latest || latest.status === BroadcastStatus.CANCELLED) {
        this.logger.log(`Broadcast ${broadcastId} cancelled mid-run`);
        return;
      }

      // Pacing delay.
      await delay(BETWEEN_BATCH_DELAY_MS);
    }

    await this.reconcileCounters(broadcastId);
    await this.broadcasts.update(broadcastId, {
      status: BroadcastStatus.COMPLETED,
      completed_at: new Date(),
    });
    this.logger.log(
      `Broadcast ${broadcastId} completed (processedAny=${processedAny})`,
    );
  }

  /**
   * One send with retry. Catches Meta errors; retries up to
   * broadcast.max_tries with exponential backoff. On final failure,
   * marks the recipient FAILED with the last error.
   */
  private async sendOne(
    recipient: BroadcastRecipient,
    broadcast: Broadcast,
    template: WhatsappTemplate,
    headerImageUrl: string | null,
  ): Promise<void> {
    // Variables are already positional + ordered from snapshot time.
    // sender.sendTemplate takes a positional string[].
    const variables = recipient.variables_resolved.map((v) =>
      v === null ? '' : String(v),
    );
    let attempt = 0;
    let lastErr: Error | null = null;
    const startedAt = Date.now();
    const windowMs = broadcast.retry_window_minutes * 60 * 1000;

    while (attempt < broadcast.max_tries) {
      // Final opt-out gate: a STOP that landed between snapshot and
      // send should prevent delivery. Cheap check per row.
      const stillSendable = await this.recipients.query(
        `SELECT 1 FROM customer WHERE id = $1 AND marketing_opted_out = false LIMIT 1`,
        [recipient.customer_id],
      );
      if (stillSendable.length === 0) {
        await this.recipients.update(recipient.id, {
          status: BroadcastRecipientStatus.FAILED,
          last_error: 'customer opted out between snapshot and send',
          attempts: attempt + 1,
        });
        return;
      }

      attempt += 1;
      try {
        const { wamid } = await this.sender.sendTemplate(
          recipient.phone,
          template.name,
          template.language,
          variables,
          headerImageUrl,
          {
            useMarketingEndpoint: template.maxPriceAmount !== null,
            perMessageBidMultiplier:
              broadcast.per_message_bid_multiplier !== null
                ? Number(broadcast.per_message_bid_multiplier)
                : null,
          },
        );
        await this.recipients.update(recipient.id, {
          status: BroadcastRecipientStatus.SENT,
          wam_id: wamid,
          attempts: attempt,
          sent_at: new Date(),
          last_error: null,
        });
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `Broadcast ${broadcast.id} recipient ${recipient.id} attempt ${attempt} failed: ${lastErr.message}`,
        );
        if (attempt >= broadcast.max_tries) break;
        if (Date.now() - startedAt > windowMs) {
          // Blew the retry window; stop retrying this one.
          break;
        }
        await delay(RETRY_BASE_DELAY_MS * attempt);
      }
    }

    await this.recipients.update(recipient.id, {
      status: BroadcastRecipientStatus.FAILED,
      attempts: attempt,
      last_error: lastErr?.message ?? 'unknown error',
    });
  }

  /**
   * Recompute aggregate counters on Broadcast from the per-row
   * status column. Called every batch so admin polling sees fresh
   * numbers; the GROUP BY cost is paid at most once per batch
   * (not per row).
   */
  private async reconcileCounters(broadcastId: string): Promise<void> {
    const rows: Array<{ status: BroadcastRecipientStatus; count: string }> =
      await this.recipients.query(
        `SELECT status, COUNT(*)::text AS count
         FROM broadcast_recipient
         WHERE broadcast_id = $1
         GROUP BY status`,
        [broadcastId],
      );
    const by = new Map(rows.map((r) => [r.status, Number(r.count)]));
    await this.broadcasts.update(broadcastId, {
      sent_count: by.get(BroadcastRecipientStatus.SENT) ?? 0,
      delivered_count: by.get(BroadcastRecipientStatus.DELIVERED) ?? 0,
      read_count: by.get(BroadcastRecipientStatus.READ) ?? 0,
      failed_count: by.get(BroadcastRecipientStatus.FAILED) ?? 0,
    });
  }

  // Expose for the delivery/read webhook handler (Phase 3.5 — not
  // in this commit but the signature is here so the controller
  // doesn't ship with a stub.
  async handleDeliveryUpdate(
    wamId: string,
    status: BroadcastRecipientStatus,
    at: Date,
  ): Promise<void> {
    const rec = await this.recipients.findOne({ where: { wam_id: wamId } });
    if (!rec) return;
    if (rec.status === status) return;
    // Only forward-flip: SENT → DELIVERED → READ; never backward
    // (Meta sometimes sends out-of-order webhooks).
    const RANK: Record<BroadcastRecipientStatus, number> = {
      PENDING: 0,
      SENT: 1,
      DELIVERED: 2,
      READ: 3,
      FAILED: 4,
    };
    if (RANK[status] <= RANK[rec.status]) return;
    const patch: Partial<BroadcastRecipient> = { status };
    if (status === BroadcastRecipientStatus.DELIVERED)
      patch.delivered_at = at;
    if (status === BroadcastRecipientStatus.READ) patch.read_at = at;
    await this.recipients.update(rec.id, patch);
    await this.reconcileCounters(rec.broadcast_id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Prevent tree-shake of the In import on strict builds.
void In;
