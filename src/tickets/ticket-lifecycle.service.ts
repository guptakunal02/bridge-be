import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  TicketActivity,
  TicketStatus,
  UserRole,
  UserStatus,
  WaitingAction,
} from '../database/enums';
import { User } from '../users/entities/user.entity';
import {
  PRESENCE_EVENTS,
  type PresenceCameOnlineEvent,
  type PresenceWentEmergencyEvent,
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
 * How long an assignee must have been OFFLINE before auto-reopen
 * falls the ticket back to the BOT queue instead of parking it in
 * their personal pile. Short absences (lunch, meeting-run-over,
 * dropped VPN) keep the original ownership so the member's "I'll
 * come back to this at X" contract isn't broken. Longer than this
 * threshold = probably off-shift or on leave; the customer must not
 * be ghosted while we wait for them.
 *
 * Non-OFFLINE statuses (MEETING / BREAK / EMERGENCY) never trigger
 * fallback — the member is at work, just temporarily unavailable;
 * they'll clear their queue soon.
 */
const REOPEN_OFFLINE_FALLBACK_MS = 4 * 60 * 60 * 1000;

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
   * Auto-resolve or auto-reopen WAITING tickets whose timer elapsed,
   * and re-queue ripe IN_FOLLOWUP tickets whose assignee is OFFLINE.
   *
   * Auto-reopen with presence check (WAITING branch): if the original
   * assignee is ONLINE (or MEETING/BREAK/EMERGENCY — present but
   * busy) the ticket stays with them. If they've been OFFLINE for
   * longer than REOPEN_OFFLINE_FALLBACK_MS, the ticket is re-queued
   * to BOT so `pullFromBotQueue` can route it to a live teammate.
   *
   * Ripe-followup re-queue (IN_FOLLOWUP branch): the capacity hook
   * (`drainRipeFollowup`) wakes followups onto their ONLINE assignee
   * when a slot frees. If the assignee is NOT ONLINE when the timer
   * elapses, nothing else would move the ticket — the customer who
   * was promised a follow-up at a specific time would be ghosted.
   * This branch handles that: ripe IN_FOLLOWUP with a non-ONLINE
   * assignee gets flipped to OPEN + re-queued to BOT in the same
   * team. The destination is BOT (not another agent), so no cap is
   * bypassed. ONLINE assignees are deliberately left alone — the
   * capacity hook will wake their followups into their personal
   * queue respecting their cap, as before. See ticket #1436
   * (2026-10-14).
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

        // Fall through even when WAITING is empty — the IN_FOLLOWUP
        // branch below still needs to run. Earlier revisions bailed
        // here with `if (ripeWaiting.length === 0) return 0;` which
        // short-circuited the followup processing entirely when the
        // only ripe timer in the DB was an IN_FOLLOWUP ticket. See
        // ticket #1436 (2026-10-14) — a solo ripe followup never
        // got swept because no WAITING tickets were ripe alongside.

        // Split by waiting_action so we issue at most two UPDATEs per
        // batch (one per branch) instead of one per ticket.
        // NULL waiting_action → treat as AUTO_RESOLVE, preserving the
        // historical behaviour for rows created before the picker.
        const toReopen = ripeWaiting.filter(
          (t) => t.waiting_action === WaitingAction.REOPEN,
        );
        const toResolve = ripeWaiting.filter(
          (t) => t.waiting_action !== WaitingAction.REOPEN,
        );

        if (toResolve.length > 0) {
          await ticketRepo
            .createQueryBuilder()
            .update()
            .set({
              status: TicketStatus.RESOLVED,
              resume_at: null,
              waiting_action: null,
              resolved_at: () => 'NOW()',
            })
            .whereInIds(toResolve.map((t) => t.id))
            .execute();
        }
        // Presence check for the REOPEN branch. Load every unique
        // assignee referenced by the ripe set in one query — bounded
        // by SWEEP_BATCH (200) so this is cheap. We only need the
        // status + status_changed_at columns.
        const assigneeIds = Array.from(
          new Set(
            toReopen
              .map((t) => t.assignee)
              .filter((id): id is string => Boolean(id)),
          ),
        );
        const assigneeRecords =
          assigneeIds.length > 0
            ? await mgr.getRepository(User).find({
                where: assigneeIds.map((id) => ({ id })),
                select: { id: true, status: true, status_changed_at: true },
              })
            : [];
        const assigneeById = new Map(
          assigneeRecords.map((u) => [u.id, u] as const),
        );

        const offlineCutoff = Date.now() - REOPEN_OFFLINE_FALLBACK_MS;
        const shouldFallbackToBot = (t: Ticket): boolean => {
          // No assignee at all → always re-queue (defensive; a
          // WAITING ticket shouldn't normally be unassigned).
          if (!t.assignee) return true;
          const user = assigneeById.get(t.assignee);
          // Assignee deleted / not in cache → re-queue so we don't
          // orphan the ticket on a dead ID.
          if (!user) return true;
          // Member is at work (ONLINE / MEETING / BREAK / EMERGENCY)
          // — keep ownership. They'll clear it when free.
          if (user.status !== UserStatus.OFFLINE) return false;
          // OFFLINE but recent: lunch, outage, meeting-run-over.
          // Keep the ticket with them; they're likely back soon.
          return user.status_changed_at.getTime() <= offlineCutoff;
        };

        const toReopenKeep = toReopen.filter((t) => !shouldFallbackToBot(t));
        const toReopenToBot = toReopen.filter(shouldFallbackToBot);

        // Fallback cases need the BOT user id. Load lazily — if
        // nothing's falling back this sweep, don't bother.
        let botId: string | null = null;
        if (toReopenToBot.length > 0) {
          const bot = await mgr
            .getRepository(User)
            .findOne({ where: { role: UserRole.BOT } });
          botId = bot?.id ?? null;
          if (!botId) {
            // No BOT user configured — surface it as a warning and
            // keep the fallback tickets with their original owner
            // (safer than nulling them out). Admin needs to seed a
            // BOT user; see UsersService.ensureBotUser.
            this.logger.warn(
              `Auto-reopen fallback skipped for ${toReopenToBot.length} ticket(s): no BOT user found`,
            );
          }
        }

        if (toReopenKeep.length > 0) {
          await ticketRepo
            .createQueryBuilder()
            .update()
            .set({
              status: TicketStatus.OPEN,
              resume_at: null,
              waiting_action: null,
            })
            .whereInIds(toReopenKeep.map((t) => t.id))
            .execute();
        }
        if (toReopenToBot.length > 0) {
          await ticketRepo
            .createQueryBuilder()
            .update()
            .set({
              status: TicketStatus.OPEN,
              resume_at: null,
              waiting_action: null,
              // If BOT user is missing we fall back to keeping the
              // original assignee (botId stays null → NOOP on this
              // column via the conditional). TypeORM's .set() with
              // undefined would exclude the column; null would clobber
              // it. We only clobber when we actually have a BOT id.
              ...(botId ? { assignee: botId } : {}),
            })
            .whereInIds(toReopenToBot.map((t) => t.id))
            .execute();
        }

        // Activity log entries — one per ticket, actor NULL means
        // "system." REOPEN branch uses REOPENED to match customer-
        // triggered reopens semantically; the free-text log field
        // disambiguates that this was the timer firing. Fallback
        // tickets additionally get an ASSIGNED_TO_BOT entry so the
        // audit trail shows where ownership moved and why.
        await logRepo.save([
          ...toResolve.map((t) => ({
            ticket_id: t.id,
            event: TicketActivity.MARKED_RESOLVED,
            actor_id: null,
            log: 'Auto-resolved — waiting period elapsed with no customer reply',
          })),
          ...toReopen.map((t) => ({
            ticket_id: t.id,
            event: TicketActivity.REOPENED,
            actor_id: null,
            log: 'Auto-reopened — waiting period elapsed with no customer reply',
          })),
          ...(botId
            ? toReopenToBot.map((t) => ({
                ticket_id: t.id,
                event: TicketActivity.ASSIGNED_TO_BOT,
                actor_id: null,
                log: 'Re-queued on reopen — original assignee offline',
              }))
            : []),
        ]);

        // IN_FOLLOWUP branch — re-queue to BOT when assignee not
        // ONLINE. Done inside the same sweep tick so a single
        // transaction handles all ripe timers (WAITING + followup).
        const ripeFollowup = await ticketRepo
          .createQueryBuilder('t')
          .where('t.status = :s', { s: TicketStatus.IN_FOLLOWUP })
          .andWhere('t.resume_at IS NOT NULL')
          .andWhere('t.resume_at < NOW()')
          .andWhere('t."deletedAt" IS NULL')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .limit(SWEEP_BATCH)
          .getMany();

        let followupRequeued = 0;
        if (ripeFollowup.length > 0) {
          const followupAssigneeIds = Array.from(
            new Set(
              ripeFollowup
                .map((t) => t.assignee)
                .filter((id): id is string => Boolean(id)),
            ),
          );
          const followupAssignees =
            followupAssigneeIds.length > 0
              ? await mgr.getRepository(User).find({
                  where: followupAssigneeIds.map((id) => ({ id })),
                  select: { id: true, status: true },
                })
              : [];
          const followupAssigneeById = new Map(
            followupAssignees.map((u) => [u.id, u] as const),
          );
          const toRequeueFollowup = ripeFollowup.filter((t) => {
            // No assignee → re-queue defensively.
            if (!t.assignee) return true;
            const u = followupAssigneeById.get(t.assignee);
            // Deleted user → re-queue.
            if (!u) return true;
            // ONLINE assignee: leave alone, capacity hook handles.
            return u.status !== UserStatus.ONLINE;
          });

          if (toRequeueFollowup.length > 0) {
            // Lazy-load BOT (reuse WAITING branch's lookup when it
            // already fetched one this sweep).
            if (!botId) {
              const bot = await mgr
                .getRepository(User)
                .findOne({ where: { role: UserRole.BOT } });
              botId = bot?.id ?? null;
            }
            if (botId) {
              await ticketRepo
                .createQueryBuilder()
                .update()
                .set({
                  status: TicketStatus.OPEN,
                  resume_at: null,
                  assignee: botId,
                })
                .whereInIds(toRequeueFollowup.map((t) => t.id))
                .execute();

              await logRepo.save(
                toRequeueFollowup.flatMap((t) => [
                  {
                    ticket_id: t.id,
                    event: TicketActivity.SENT_BACK_TO_QUEUE,
                    actor_id: null,
                    log: 'Auto-woken from followup — timer elapsed and assignee offline',
                  },
                  {
                    ticket_id: t.id,
                    event: TicketActivity.ASSIGNED_TO_BOT,
                    actor_id: null,
                    log: 'Re-queued on followup wake — original assignee offline',
                  },
                ]),
              );
              followupRequeued = toRequeueFollowup.length;
            } else {
              this.logger.warn(
                `Followup re-queue skipped for ${toRequeueFollowup.length} ticket(s): no BOT user found`,
              );
            }
          }
        }

        return ripeWaiting.length + followupRequeued;
      });
      if (swept === 0) break;
      processed += swept;
      if (swept < SWEEP_BATCH) break;
    }
    if (processed > 0) {
      this.logger.log(`Timer sweep processed ${processed} ticket(s)`);
    }
  }

  /**
   * Customer just replied on this ticket. WAITING is exactly the
   * state that gets unblocked by a customer reply — flip it back
   * to OPEN and drop the timer.
   *
   * Presence-aware ownership: this is an UNCHOSEN reopen (customer
   * forced the moment, not the member), so if the original assignee
   * isn't ONLINE right now, re-queue to BOT in the same team so an
   * available teammate can pick it up via the normal capacity-
   * backfill path. MEETING / BREAK / EMERGENCY / OFFLINE all
   * re-queue — only ONLINE counts as assignable here (see
   * memory/feedback-auto-reopen-fallback.md). Presence alone — no
   * bandwidth check. Distinct from the timer-based sweep which uses
   * a looser OFFLINE-only / 4h cutoff because the member explicitly
   * chose that re-engagement time.
   *
   * IN_FOLLOWUP is DELIBERATELY not woken here. Followup means "we
   * told the customer we'd come back to them at a specific time";
   * letting an anxious customer's follow-up mail keep yanking the
   * ticket back into the live queue defeats the point. The followup
   * timer stays authoritative — the ticket reopens only when the
   * sweep + capacity hook decide it's ripe. The customer's reply is
   * still stored on the ticket by the surrounding ingest transaction,
   * so the member sees it in context the moment the followup expires.
   *
   * Caller passes the surrounding transaction's EntityManager so this
   * commits atomically with the inbound message row.
   *
   * Uses a conditional UPDATE (WHERE status = WAITING) so it's a
   * no-op if the sweep already resolved the ticket, another
   * concurrent reply woke it first, or a member transitioned it
   * manually between our read and write. That kills the duplicate-
   * log race + the sweep-vs-reply race in one move.
   */
  async wakeIfPaused(ticketId: string, mgr: EntityManager): Promise<void> {
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);
    const userRepo = mgr.getRepository(User);

    // Fetch status + current assignee in one read so we can decide
    // the fallback without a second round-trip.
    const ticket = await ticketRepo.findOne({
      where: { id: ticketId },
      select: { id: true, status: true, assignee: true },
    });
    if (!ticket) return;
    if (ticket.status !== TicketStatus.WAITING) return;

    // Presence check — same model as reopenResolved. Re-queue when
    // the real-user assignee isn't ONLINE; BOT-assigned tickets stay
    // on BOT (nothing to reroute).
    let fallbackBotId: string | null = null;
    let fallbackFromStatus: UserStatus | 'DELETED' | null = null;
    if (ticket.assignee) {
      const assignee = await userRepo.findOne({
        where: { id: ticket.assignee },
        select: { id: true, status: true, role: true },
      });
      const shouldFallback =
        !assignee ||
        (assignee.role !== UserRole.BOT &&
          assignee.status !== UserStatus.ONLINE);
      if (shouldFallback) {
        const bot = await userRepo.findOne({
          where: { role: UserRole.BOT },
        });
        if (bot) {
          fallbackBotId = bot.id;
          fallbackFromStatus = assignee?.status ?? 'DELETED';
        } else {
          this.logger.warn(
            `wakeIfPaused fallback skipped for ticket=${ticketId}: no BOT user found`,
          );
        }
      }
    }

    const result = await ticketRepo
      .createQueryBuilder()
      .update()
      .set({
        status: TicketStatus.OPEN,
        resume_at: null,
        waiting_action: null,
        ...(fallbackBotId ? { assignee: fallbackBotId } : {}),
      })
      .where('id = :id', { id: ticketId })
      .andWhere('status = :s', { s: TicketStatus.WAITING })
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
        log: 'Auto-woken from WAITING — customer replied',
      });
      if (fallbackBotId) {
        await logRepo.save({
          ticket_id: ticketId,
          event: TicketActivity.ASSIGNED_TO_BOT,
          actor_id: null,
          log: `Re-queued on wake — original assignee not ONLINE (${fallbackFromStatus})`,
        });
      }
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

  /**
   * Agent just flipped to EMERGENCY. Bounce every OPEN ticket they
   * own back to the BOT queue in the SAME team so a live teammate
   * can pick them up via the normal capacity-backfill path. The
   * enum docstring at database/enums.ts has always promised this
   * behaviour; nothing wired it up until the WENT_EMERGENCY event
   * was added.
   *
   * Scope — only OPEN tickets:
   *   * WAITING / IN_FOLLOWUP intentionally stay — they'll reopen on
   *     the member's timer, and the wake / reopen paths already have
   *     presence-aware fallbacks (ONLINE-only, re-queue if not).
   *   * BOT-assigned tickets are already in the queue — skipped by
   *     the assignee filter.
   *
   * Best-effort: swallows errors internally so a DB blip here doesn't
   * surface on an already-committed status change in the caller.
   */
  @OnEvent(PRESENCE_EVENTS.WENT_EMERGENCY)
  async bounceOnEmergency(
    payload: PresenceWentEmergencyEvent,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (mgr) => {
        const ticketRepo = mgr.getRepository(Ticket);
        const userRepo = mgr.getRepository(User);
        const logRepo = mgr.getRepository(TicketActivityLog);

        const openTickets = await ticketRepo
          .createQueryBuilder('t')
          .where('t.assignee = :userId', { userId: payload.userId })
          .andWhere('t.status = :s', { s: TicketStatus.OPEN })
          .andWhere('t."deletedAt" IS NULL')
          .select(['t.id'])
          .getMany();
        if (openTickets.length === 0) return;

        const bot = await userRepo.findOne({
          where: { role: UserRole.BOT },
        });
        if (!bot) {
          // Keep the status change but surface the warning so admin
          // can seed the BOT user. Prevents orphaning on a dead id.
          this.logger.warn(
            `EMERGENCY bounce skipped for user=${payload.userId}: no BOT user found`,
          );
          return;
        }

        await ticketRepo
          .createQueryBuilder()
          .update()
          .set({ assignee: bot.id })
          .whereInIds(openTickets.map((t) => t.id))
          .execute();

        await logRepo.save(
          openTickets.map((t) => ({
            ticket_id: t.id,
            event: TicketActivity.ASSIGNED_TO_BOT,
            actor_id: null,
            log: 'Re-queued — assignee set status to EMERGENCY',
          })),
        );

        this.logger.log(
          `Bounced ${openTickets.length} OPEN ticket(s) off user=${payload.userId} on EMERGENCY transition`,
        );
      });
    } catch (err) {
      this.logger.warn(
        `EMERGENCY bounce failed for user=${payload.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async drainRipeFollowup(
    userId: string,
    mgr: EntityManager,
  ): Promise<boolean> {
    const ticketRepo = mgr.getRepository(Ticket);
    const logRepo = mgr.getRepository(TicketActivityLog);
    const userRepo = mgr.getRepository(User);

    // Presence gate — mirrors pullFromBotQueue:552. onCapacityFreed
    // doesn't check presence itself (it fires on any action that
    // moves one of the agent's tickets off OPEN, including admins /
    // automations / the sweep resolving a ticket owned by an
    // offline member), so without this check a followup ticket
    // would wake onto an offline agent. The agent is unreachable;
    // the customer waits; nobody picks it up. The ticket just
    // stays IN_FOLLOWUP until the agent comes back online — at
    // which point drainOnCameOnline → onCapacityFreed → this
    // method runs again and wakes it onto them. See ticket #1357
    // (2026-10-14).
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user || user.status !== UserStatus.ONLINE) return false;

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
    // stepped away (break / meeting / signed out) between the slot
    // freeing and this hook firing, leave the ticket parked on BOT
    // — they'll get it when they come back (drainOnCameOnline
    // handles the catch-up), or someone else online will take it.
    // Historical bug (ticket #544/#545, 2026-10-06): the comment
    // claimed this gate existed but the code only checked role.
    // Offline Divya got auto-assigned a backfill when a resolved
    // ticket freed her slot.
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user || user.role === UserRole.BOT) return false;
    if (user.status !== UserStatus.ONLINE) return false;

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
