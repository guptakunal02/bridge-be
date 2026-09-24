import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { TicketActivity, TicketStatus, UserRole } from '../database/enums';
import { User } from '../users/entities/user.entity';
import {
  PRESENCE_EVENTS,
  type PresenceCameOnlineEvent,
} from '../users/presence.service';
import { Ticket } from './entities/ticket.entity';
import { TicketActivityLog } from './entities/ticket-activity-log.entity';

/** How often the timer sweep fires (ms). One minute is granular enough for hourly durations. */
const TIMER_SWEEP_MS = 60 * 1000;

/**
 * Batch size for each sweep pass. Bounds lock duration and memory
 * when a downtime backlog produces thousands of ripe rows at once —
 * we drain in chunks rather than lifting the whole set into memory.
 */
const SWEEP_BATCH = 200;

/**
 * Advisory-lock key for the sweep — makes it singleton across N
 * backend workers without adding a coordinator. `pg_try_advisory_lock`
 * is per-session (auto-released on disconnect), so a crashed worker
 * doesn't strand the lock. Value is arbitrary but must be stable.
 */
const SWEEP_ADVISORY_LOCK_KEY = 4726050001;

/**
 * Safety cap on the "drain to me on Online" loop so a broken picker
 * can't starve the process. Real cap is bounded by the agent's total
 * per-team cap sum, which will always be far smaller than this.
 */
const ONLINE_DRAIN_MAX = 50;

/**
 * Owns the automated lifecycle transitions that aren't triggered
 * directly by an agent's PATCH:
 *
 *   1. Timer sweep (setInterval, once a minute):
 *        - WAITING with resume_at < NOW()  → RESOLVED (auto)
 *        - IN_FOLLOWUP timers just become "ripe" — the capacity hook
 *          picks them up when the assignee next frees a slot. We
 *          don't auto-drain to OPEN in the sweep because that would
 *          bypass the cap.
 *
 *   2. Customer reply wake (called from EmailInboxService inside the
 *      ingest transaction):
 *        - WAITING or IN_FOLLOWUP → OPEN
 *        - Clears resume_at; assignee unchanged
 *
 *   3. Capacity-free backfill (called from TicketsService after a
 *      user-driven status change out of OPEN):
 *        - First: pull the oldest ripe IN_FOLLOWUP owned by the
 *          same agent and wake it to OPEN.
 *        - Else: pull the oldest BOT-queued ticket in any team this
 *          agent belongs to (respecting paused_in_team) and re-assign.
 *        - At most ONE ticket moves per capacity-free event; the cap
 *          is +1, not "top up to max."
 */
@Injectable()
export class TicketLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TicketLifecycleService.name);
  private timerHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.timerHandle = setInterval(() => {
      this.sweepTimers().catch((err: unknown) => {
        this.logger.error(
          `Timer sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, TIMER_SWEEP_MS);
    // Fire once immediately at boot so tickets whose timers expired
    // during a restart don't sit for up to a minute. Same error
    // swallowing as the interval — a transient DB blip at boot must
    // not crash the process.
    this.sweepTimers().catch((err: unknown) => {
      this.logger.error(
        `Initial timer sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  onModuleDestroy(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /**
   * Auto-resolve WAITING tickets whose timer elapsed. IN_FOLLOWUP is
   * intentionally left alone — the capacity hook wakes those on
   * demand.
   *
   * Runs behind a session-scoped advisory lock so only ONE worker
   * sweeps per tick; the others try, fail to acquire, and go back to
   * sleep. Drains in batches to bound memory + lock duration when a
   * post-downtime backlog spikes.
   */
  async sweepTimers(): Promise<void> {
    let processed = 0;
    // Outer loop so we can drain multiple batches in one tick if the
    // backlog is deep — but only while we still hold the singleton
    // lock. Each pass gets its own txn so waiting rows never sit
    // under a lock for more than one batch's worth of work.
    for (;;) {
      const swept = await this.dataSource.transaction(async (mgr) => {
        const gotLock: Array<{ locked: boolean }> = await mgr.query(
          `SELECT pg_try_advisory_xact_lock($1) AS locked`,
          [SWEEP_ADVISORY_LOCK_KEY],
        );
        if (!gotLock[0]?.locked) return 0;

        const ticketRepo = mgr.getRepository(Ticket);
        const logRepo = mgr.getRepository(TicketActivityLog);

        const ripeWaiting = await ticketRepo
          .createQueryBuilder('t')
          .where('t.status = :s', { s: TicketStatus.WAITING })
          .andWhere('t.resume_at IS NOT NULL')
          .andWhere('t.resume_at < NOW()')
          .andWhere('t."deletedAt" IS NULL')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .limit(SWEEP_BATCH)
          .getMany();

        if (ripeWaiting.length === 0) return 0;

        const ids = ripeWaiting.map((t) => t.id);
        await ticketRepo
          .createQueryBuilder()
          .update()
          .set({
            status: TicketStatus.RESOLVED,
            resume_at: null,
            resolved_at: () => 'NOW()',
          })
          .whereInIds(ids)
          .execute();

        // Activity log entries — one per ticket, actor NULL means
        // "system." Ops UI already renders these gracefully.
        await logRepo.save(
          ripeWaiting.map((t) => ({
            ticket_id: t.id,
            event: TicketActivity.MARKED_RESOLVED,
            actor_id: null,
            log: 'Auto-resolved — waiting period elapsed with no customer reply',
          })),
        );
        return ripeWaiting.length;
      });
      if (swept === 0) break;
      processed += swept;
      if (swept < SWEEP_BATCH) break;
    }
    if (processed > 0) {
      this.logger.log(`Auto-resolved ${processed} WAITING ticket(s)`);
    }
  }

  /**
   * Customer just replied on this ticket. If it was paused (WAITING
   * or IN_FOLLOWUP), flip it back to OPEN and drop the timer.
   * Assignee stays the same — it's still their thread to close.
   *
   * Caller passes the surrounding transaction's EntityManager so this
   * commits atomically with the inbound message row.
   *
   * Uses a conditional UPDATE (WHERE status IN paused-set) so it's
   * a no-op if the sweep already resolved the ticket, another
   * concurrent reply woke it first, or an agent transitioned it
   * manually between our read and write. That kills the duplicate-
   * log race + the sweep-vs-reply race in one move.
   */
  async wakeIfPaused(ticketId: string, mgr: EntityManager): Promise<void> {
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);

    // Fetch just the current status for the log message; the write
    // is conditional so we don't need the whole row locked.
    const ticket = await ticketRepo.findOne({
      where: { id: ticketId },
      select: { id: true, status: true },
    });
    if (!ticket) return;
    if (
      ticket.status !== TicketStatus.WAITING &&
      ticket.status !== TicketStatus.IN_FOLLOWUP
    ) {
      return;
    }

    const result = await ticketRepo
      .createQueryBuilder()
      .update()
      .set({ status: TicketStatus.OPEN, resume_at: null })
      .where('id = :id', { id: ticketId })
      .andWhere('status IN (:...paused)', {
        paused: [TicketStatus.WAITING, TicketStatus.IN_FOLLOWUP],
      })
      .execute();

    // Only log if we were the transaction that actually flipped
    // the row. Prevents duplicate activity entries when two replies
    // (or a reply + a manual PATCH) land on the same paused ticket
    // at the same time.
    if ((result.affected ?? 0) > 0) {
      await logRepo.save({
        ticket_id: ticketId,
        event: TicketActivity.SENT_BACK_TO_QUEUE,
        actor_id: null,
        log: `Auto-woken from ${ticket.status} — customer replied`,
      });
    }
  }

  /**
   * An agent's ticket just left the OPEN column (resolved / put to
   * waiting / put to followup). One of their tickets can slide into
   * the freed slot:
   *
   *   1. If any IN_FOLLOWUP ticket assigned to this agent is ripe
   *      (resume_at <= NOW()), wake the oldest-resumed one.
   *   2. Otherwise, take the oldest BOT-queued ticket in any team
   *      this agent belongs to (respecting paused_in_team + team
   *      pause + the target team's cap for this agent) and re-assign
   *      it to them.
   *
   * Best-effort: swallows errors internally so it never fails an
   * already-committed status change. Returns whether it actually
   * moved a ticket, which the drain loop uses to know when to stop.
   */
  async onCapacityFreed(userId: string): Promise<boolean> {
    try {
      return await this.dataSource.transaction(async (mgr) => {
        if (await this.drainRipeFollowup(userId, mgr)) return true;
        return await this.pullFromBotQueue(userId, mgr);
      });
    } catch (err) {
      this.logger.warn(
        `Capacity backfill failed for user=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Flood-fill the agent's inbox up to their remaining cap across
   * every team they belong to. Fired when they come Online — the
   * queue may have been backing up while they were away.
   *
   * Loops `onCapacityFreed` until nothing more can be drained. Each
   * call is its own txn so long queues don't hold locks across the
   * whole fill. The safety cap prevents runaway loops if a picker
   * bug ever returns true forever.
   */
  @OnEvent(PRESENCE_EVENTS.CAME_ONLINE)
  async drainOnCameOnline(payload: PresenceCameOnlineEvent): Promise<void> {
    let drained = 0;
    for (let i = 0; i < ONLINE_DRAIN_MAX; i++) {
      const moved = await this.onCapacityFreed(payload.userId);
      if (!moved) break;
      drained++;
    }
    if (drained > 0) {
      this.logger.log(
        `Drained ${drained} ticket(s) to user=${payload.userId} on Online transition`,
      );
    }
  }

  private async drainRipeFollowup(
    userId: string,
    mgr: EntityManager,
  ): Promise<boolean> {
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);

    const ripe = await ticketRepo
      .createQueryBuilder('t')
      .where('t.assignee = :userId', { userId })
      .andWhere('t.status = :s', { s: TicketStatus.IN_FOLLOWUP })
      .andWhere('t.resume_at IS NOT NULL')
      .andWhere('t.resume_at <= NOW()')
      .andWhere('t."deletedAt" IS NULL')
      .orderBy('t.resume_at', 'ASC')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .limit(1)
      .getOne();

    if (!ripe) return false;

    await ticketRepo.update(
      { id: ripe.id },
      { status: TicketStatus.OPEN, resume_at: null },
    );
    await logRepo.save({
      ticket_id: ripe.id,
      event: TicketActivity.SENT_BACK_TO_QUEUE,
      actor_id: null,
      log: 'Auto-woken from followup — timer elapsed and slot freed',
    });
    return true;
  }

  private async pullFromBotQueue(
    userId: string,
    mgr: EntityManager,
  ): Promise<boolean> {
    const userRepo = mgr.getRepository(User);
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);

    // Only ONLINE + non-BOT users pull from the queue. If the agent
    // stepped away between transitions, let the next round-robin pick
    // handle it instead.
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user || user.role === UserRole.BOT) return false;

    const bot = await userRepo.findOne({ where: { role: UserRole.BOT } });
    if (!bot) return false;

    // Same cap check the assignment picker uses — freeing a slot in
    // Team A doesn't entitle us to overflow the agent's cap in Team B.
    // Candidate ticket's team must have room for this agent.
    const candidate = await ticketRepo
      .createQueryBuilder('t')
      .innerJoin(
        'team_member',
        'tm',
        'tm.team_id = t.team_id AND tm.user_id = :userId AND tm.paused_in_team = false',
        { userId },
      )
      .innerJoin('team', 'team', 'team.id = t.team_id')
      .where('t.assignee = :botId', { botId: bot.id })
      .andWhere('t.status = :openStatus', { openStatus: TicketStatus.OPEN })
      .andWhere('t."deletedAt" IS NULL')
      .andWhere('team.assignment_paused = false')
      .andWhere(
        `(SELECT COUNT(*) FROM public.ticket
            WHERE assignee = :userId
              AND team_id = t.team_id
              AND status = :openStatus
              AND "deletedAt" IS NULL)
         < tm.max_concurrent_tickets`,
      )
      .orderBy('t.createdAt', 'ASC')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .limit(1)
      .getOne();

    if (!candidate) return false;

    await ticketRepo.update({ id: candidate.id }, { assignee: userId });
    await userRepo.update({ id: userId }, { last_assigned_at: new Date() });
    await logRepo.save({
      ticket_id: candidate.id,
      event: TicketActivity.ASSIGNED_TO_AGENT,
      actor_id: null,
      log: `Auto-assigned to ${user.name} on capacity backfill`,
    });
    return true;
  }
}
