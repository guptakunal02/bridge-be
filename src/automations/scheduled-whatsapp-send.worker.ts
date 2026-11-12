import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { ScheduledSendStatus } from '../database/enums';
import { ActionDispatcher } from './action-dispatcher.service';
import type { Action } from './action';
import { ScheduledWhatsappSend } from './entities/scheduled-whatsapp-send.entity';
import type { AutomationEventPayload } from './events';

/**
 * Drains scheduled_whatsapp_send on a 60s tick. Each tick:
 *   1. SELECT up to BATCH_SIZE rows WHERE status=PENDING AND
 *      scheduled_at <= NOW(), ordered by scheduled_at ASC.
 *   2. For each row, re-enter ActionDispatcher.dispatch with the
 *      snapshotted action (delay_minutes=0 → falls straight through
 *      to the send_whatsapp_template handler) + snapshotted ctx.
 *   3. Mark row SENT on success, FAILED with last_error on throw.
 *
 * Why not use SELECT FOR UPDATE SKIP LOCKED for multi-worker safety:
 *   V1 runs single-process pm2 (bridge-be is one node). The worker
 *   is at-most-once per row by virtue of the single process + the
 *   status flip. If we ever go multi-node, add the row-lock here —
 *   the index is already (status, scheduled_at) so the predicate
 *   covers the lock scan.
 *
 * Restart safety: rows left PENDING across a restart simply get
 * picked up on the next tick after boot — they're idempotent writes,
 * timestamps don't matter for correctness once scheduled_at has
 * passed. No SENDING sentinel state to clean up (unlike the broadcast
 * worker which does mid-batch commits).
 */
const TICK_INTERVAL_MS = 60_000;
const BATCH_SIZE = 50;

@Injectable()
export class ScheduledWhatsappSendWorker implements OnModuleInit {
  private readonly logger = new Logger(ScheduledWhatsappSendWorker.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(ScheduledWhatsappSend)
    private readonly scheduled: Repository<ScheduledWhatsappSend>,
    // forwardRef because ActionDispatcher sits in the same module
    // graph as this worker; NestJS wires them lazily either way but
    // the explicit forwardRef is a safeguard against future refactors.
    @Inject(forwardRef(() => ActionDispatcher))
    private readonly dispatcher: ActionDispatcher,
  ) {}

  onModuleInit(): void {
    // Fire once on boot (catches rows whose scheduled_at passed while
    // the process was down), then every tick.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    let due: ScheduledWhatsappSend[];
    try {
      due = await this.scheduled.find({
        where: {
          status: ScheduledSendStatus.PENDING,
          scheduled_at: LessThanOrEqual(new Date()),
        },
        order: { scheduled_at: 'ASC' },
        take: BATCH_SIZE,
      });
    } catch (err) {
      this.logger.warn(
        `Scheduled-send tick: SELECT failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (due.length === 0) return;
    this.logger.log(
      `TRACE_SCHEDULE_DRAIN picked=${due.length} oldest=${due[0]!.scheduled_at.toISOString()}`,
    );

    for (const row of due) {
      await this.runOne(row);
    }
  }

  private async runOne(row: ScheduledWhatsappSend): Promise<void> {
    const action = row.action_config as unknown as Action;
    const ctx = row.event_ctx as unknown as AutomationEventPayload;
    try {
      await this.dispatcher.dispatch(action, ctx);
      await this.scheduled.update(row.id, {
        status: ScheduledSendStatus.SENT,
        sent_at: new Date(),
        attempts: row.attempts + 1,
      });
      this.logger.log(
        `TRACE_SCHEDULE_SENT id=${row.id} ticket=${ctx.ticket?.id ?? 'null'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Scheduled send ${row.id} crashed: ${msg} — marking FAILED (no retry in V1)`,
      );
      await this.scheduled.update(row.id, {
        status: ScheduledSendStatus.FAILED,
        last_error: msg.slice(0, 2000),
        attempts: row.attempts + 1,
      });
    }
  }
}
