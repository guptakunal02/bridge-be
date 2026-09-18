import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { BotRuntimeService } from '../bot/runtime/bot-runtime.service';
import {
  BotTrigger,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { buildTicketContext } from '../rules/ticket-context';
import { User } from '../users/entities/user.entity';
import { PresenceService } from '../users/presence.service';
import type { ListTicketsQuery, TicketScope } from './dto/list-tickets.dto';
import {
  TicketDetail,
  TicketListItem,
  toTicketDetail,
  toTicketListItem,
} from './dto/ticket-response.dto';
import type { UpdateTicketDto } from './dto/update-ticket.dto';
import { Ticket } from './entities/ticket.entity';
import { TicketActivityLog } from './entities/ticket-activity-log.entity';
import { TicketLifecycleService } from './ticket-lifecycle.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Every ticket status that is NOT terminal — the ones a member is
 * still expected to act on. RESOLVED is intentionally excluded.
 */
const OPEN_STATUSES: TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.IN_FOLLOWUP,
  TicketStatus.WAITING,
];

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketActivityLog)
    private readonly activity: Repository<TicketActivityLog>,
    @InjectRepository(EmailMessage)
    private readonly emails: Repository<EmailMessage>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly presence: PresenceService,
    private readonly runtime: BotRuntimeService,
    private readonly lifecycle: TicketLifecycleService,
  ) {}

  async list(
    query: ListTicketsQuery,
    actingUser: AuthenticatedUser,
  ): Promise<TicketListItem[]> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = query.offset ?? 0;

    const qb = this.tickets
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.assigneeUser', 'assignee')
      .orderBy('t.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    if (query.status) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    if (query.channelId) {
      qb.andWhere('t.channel_id = :channelId', { channelId: query.channelId });
    }
    await this.applyScope(qb, query.scope ?? 'all', actingUser);

    const rows = await qb.getMany();
    if (rows.length === 0) return [];

    const latestByTicket = await this.fetchLatestMessages(
      rows.map((t) => t.id),
    );
    return rows.map((t) =>
      toTicketListItem(t, latestByTicket.get(t.id) ?? null),
    );
  }

  /**
   * Numbers for the member top strip:
   *   teamQueueCount  — total tickets parked on BOT (i.e. genuinely
   *                     unassigned), across every channel
   *   activeOnMe      — my tickets that aren't RESOLVED
   *   resolvedTodayByMe — my resolves since IST midnight
   *
   * IST is baked into the query via `AT TIME ZONE 'Asia/Kolkata'`
   * so the cutoff matches the ops team's local day even when the DB
   * clock is UTC.
   */
  async myStats(actingUser: AuthenticatedUser): Promise<{
    teamQueueCount: number;
    activeOnMe: number;
    resolvedTodayByMe: number;
  }> {
    const bot = await this.users.findOne({ where: { role: UserRole.BOT } });
    const botId = bot?.id ?? null;

    const teamQueueCount = botId
      ? await this.tickets.count({
          where: { assignee: botId, status: In(OPEN_STATUSES) },
        })
      : 0;

    const activeOnMe = await this.tickets.count({
      where: { assignee: actingUser.id, status: In(OPEN_STATUSES) },
    });

    // Resolved-today = every MARKED_RESOLVED log this user authored
    // since IST midnight. Actor is stored explicitly on the log row
    // so this is a straight equality filter, not a LIKE match. IST
    // baked into the WHERE via AT TIME ZONE so the cutoff matches
    // the ops team's local day regardless of the DB clock.
    const resolvedRows: Array<{ count: string }> = await this.activity
      .createQueryBuilder('a')
      .select('COUNT(a.id)', 'count')
      .where('a.event = :event', { event: TicketActivity.MARKED_RESOLVED })
      .andWhere('a.actor_id = :actorId', { actorId: actingUser.id })
      .andWhere(
        `a."createdAt" AT TIME ZONE 'Asia/Kolkata' >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata')`,
      )
      .getRawMany();
    const resolvedTodayByMe = Number(resolvedRows[0]?.count ?? 0);

    return { teamQueueCount, activeOnMe, resolvedTodayByMe };
  }

  /**
   * Every distinct tag ever attached to a ticket, sorted. Backs the
   * autocomplete in the tag chip editor. Postgres' UNNEST + DISTINCT
   * is O(N) over ticket rows — cheap enough at MVP scale; add a
   * materialised view if it ever gets slow.
   */
  async listTags(): Promise<string[]> {
    const rows: Array<{ tag: string }> = await this.tickets.manager.query(
      `SELECT DISTINCT unnest(tags) AS tag
       FROM public.ticket
       WHERE "deletedAt" IS NULL
       ORDER BY tag ASC`,
    );
    return rows.map((r) => r.tag);
  }

  async get(id: string): Promise<TicketDetail> {
    const ticket = await this.tickets.findOne({
      where: { id },
      relations: { assigneeUser: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const [messages, activity] = await Promise.all([
      this.emails.find({
        where: { ticket_id: id },
        order: { createdAt: 'ASC' },
      }),
      this.activity.find({
        where: { ticket_id: id },
        order: { createdAt: 'ASC' },
      }),
    ]);

    return toTicketDetail(ticket, messages, activity);
  }

  /**
   * Apply status and/or assignee changes, log the appropriate activity
   * events, and return the fresh detail view. Everything runs in a
   * single transaction so a mid-flight failure leaves no partial log.
   */
  async update(
    id: string,
    dto: UpdateTicketDto,
    actingUser: AuthenticatedUser,
  ): Promise<TicketDetail> {
    if (
      dto.status === undefined &&
      dto.assigneeId === undefined &&
      dto.tags === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }

    // Capture added tags across the txn boundary — we fire a
    // BotTrigger.TICKET_TAG_ADDED after commit so the runtime never
    // runs inside our write transaction.
    let addedTags: string[] = [];
    // Capture "this transition freed capacity for a human agent" so
    // we can call the backfill hook post-commit. Set only when a
    // human's OPEN ticket moves to a non-OPEN status.
    let freedCapacityFor: string | null = null;

    await this.dataSource.transaction(async (mgr) => {
      const ticketRepo = mgr.getRepository(Ticket);
      const logRepo = mgr.getRepository(TicketActivityLog);
      const userRepo = mgr.getRepository(User);

      const ticket = await ticketRepo.findOne({
        where: { id },
        relations: { assigneeUser: true },
      });
      if (!ticket) throw new NotFoundException('Ticket not found');

      const patch: Partial<Ticket> = {};
      const logs: Array<{ event: TicketActivity; log: string }> = [];

      // A human agent's OPEN ticket represents an occupied slot in
      // their team's cap. Any transition that ends that agent's
      // ownership of the OPEN state — reassigned away OR status
      // moved off OPEN — frees the slot and triggers the backfill.
      const heldOpenByHuman =
        ticket.status === TicketStatus.OPEN &&
        ticket.assigneeUser?.role !== UserRole.BOT;

      if (dto.assigneeId !== undefined && dto.assigneeId !== ticket.assignee) {
        const nextUser = await userRepo.findOne({
          where: { id: dto.assigneeId },
        });
        if (!nextUser) {
          throw new NotFoundException('Assignee user not found');
        }
        const prevRole = ticket.assigneeUser?.role ?? null;
        const event = pickAssigneeEvent(prevRole, nextUser.role);
        patch.assignee = nextUser.id;
        if (heldOpenByHuman) freedCapacityFor = ticket.assignee;
        logs.push({
          event,
          log: `Assignee changed to ${nextUser.name} (${nextUser.role}) by ${actingUser.email ?? actingUser.id}`,
        });
      }

      if (dto.status !== undefined && dto.status !== ticket.status) {
        const event = pickStatusEvent(ticket.status, dto.status);
        patch.status = dto.status;
        // OPEN → anything-else frees the agent's slot (same rule as
        // reassign-away above; either can trigger the backfill,
        // whichever fires first wins the assignment).
        if (heldOpenByHuman && dto.status !== TicketStatus.OPEN) {
          freedCapacityFor = ticket.assignee;
        }
        if (
          ticket.status === TicketStatus.RESOLVED &&
          dto.status !== TicketStatus.RESOLVED
        ) {
          patch.is_reopened = true;
        }

        // Timer field: set when entering WAITING/IN_FOLLOWUP,
        // clear otherwise. resumeAtHours is required for the two
        // paused statuses and rejected for the others.
        if (
          dto.status === TicketStatus.WAITING ||
          dto.status === TicketStatus.IN_FOLLOWUP
        ) {
          if (dto.resumeAtHours === undefined) {
            throw new BadRequestException(
              `resumeAtHours is required when moving a ticket to ${dto.status}`,
            );
          }
          patch.resume_at = new Date(
            Date.now() + dto.resumeAtHours * 60 * 60 * 1000,
          );
        } else {
          // OPEN / RESOLVED — no timer.
          if (dto.resumeAtHours !== undefined) {
            throw new BadRequestException(
              `resumeAtHours only applies to WAITING or IN_FOLLOWUP`,
            );
          }
          patch.resume_at = null;
        }

        logs.push({
          event,
          log: `Status ${ticket.status} → ${dto.status} by ${actingUser.email ?? actingUser.id}`,
        });
      } else if (dto.resumeAtHours !== undefined) {
        // Sent without an accompanying status change — nothing to
        // do here; the FE only ever pairs it with a WAITING/FOLLOWUP
        // transition. Rather than silently accept, be loud.
        throw new BadRequestException(
          `resumeAtHours only applies to WAITING or IN_FOLLOWUP transitions`,
        );
      }

      if (dto.tags !== undefined) {
        const nextTags = normaliseTags(dto.tags);
        const prevTags = (ticket.tags ?? []).slice().sort();
        const nextSorted = nextTags.slice().sort();
        if (!arraysEqual(prevTags, nextSorted)) {
          patch.tags = nextTags;
          const added = nextTags.filter((t) => !prevTags.includes(t));
          const removed = prevTags.filter((t) => !nextTags.includes(t));
          addedTags = added;
          const parts: string[] = [];
          if (added.length) parts.push(`added [${added.join(', ')}]`);
          if (removed.length) parts.push(`removed [${removed.join(', ')}]`);
          logs.push({
            event: TicketActivity.NOTES_ADDED,
            log: `Tags ${parts.join('; ')} by ${actingUser.email ?? actingUser.id}`,
          });
        }
      }

      if (Object.keys(patch).length > 0) {
        await ticketRepo.update({ id }, patch);
      }
      for (const entry of logs) {
        await logRepo.save({
          ticket_id: id,
          event: entry.event,
          actor_id: actingUser.id,
          log: entry.log,
        });
      }
    });

    // Presence + capacity backfill are both best-effort side effects
    // that fire AFTER the write commits. Isolate them so a failure in
    // one doesn't skip the other — a stale presence timestamp mustn't
    // block a slot from being backfilled.
    try {
      await this.presence.slideOnActivity(actingUser.id);
    } catch {
      // presence slide is telemetry-adjacent; safe to swallow.
    }

    if (freedCapacityFor) {
      // Lifecycle swallows internally and warns; awaited so the FE's
      // next refetch sees the drained ticket.
      await this.lifecycle.onCapacityFreed(freedCapacityFor);
    }

    const detail = await this.get(id);

    // Fire TICKET_TAG_ADDED to any flow that keys off it. `added_tags`
    // is exposed as a first-class variable so flow authors can branch
    // on "which tag was just added" without walking the whole tags
    // array.
    if (addedTags.length > 0) {
      try {
        const firstMsg = detail.messages[0] ?? null;
        await this.runtime.startSession({
          ticketId: id,
          channelId: detail.channelId,
          trigger: BotTrigger.TICKET_TAG_ADDED,
          initialVariables: {
            ...buildTicketContext({
              createdAt: new Date(detail.createdAt),
              channelType: detail.channelType,
              senderEmail: firstMsg?.sender ?? null,
              subject: firstMsg?.subject ?? null,
              tags: detail.tags,
            }),
            added_tags: addedTags,
          },
        });
      } catch {
        // Runtime failures are logged inside the service — swallow
        // so the human-side PATCH still returns success.
      }
    }

    return detail;
  }

  private async applyScope(
    qb: ReturnType<Repository<Ticket>['createQueryBuilder']>,
    scope: TicketScope,
    actingUser: AuthenticatedUser,
  ): Promise<void> {
    if (scope === 'mine') {
      qb.andWhere('t.assignee = :meId', { meId: actingUser.id });
      return;
    }
    if (scope === 'unassigned') {
      const bot = await this.users.findOne({ where: { role: UserRole.BOT } });
      if (!bot) {
        // No bot seeded means no ticket can be "unassigned" under this model.
        qb.andWhere('1 = 0');
        return;
      }
      qb.andWhere('t.assignee = :botId', { botId: bot.id });
    }
  }

  /**
   * Fetch the newest EmailMessage for each ticket id in a single round
   * trip using Postgres' `DISTINCT ON` — far cheaper than N per-ticket
   * queries and avoids the LEFT JOIN LATERAL boilerplate.
   */
  private async fetchLatestMessages(
    ticketIds: string[],
  ): Promise<Map<string, EmailMessage>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.emails.find({
      where: { ticket_id: In(ticketIds) },
      order: { ticket_id: 'ASC', createdAt: 'DESC' },
    });
    // Fall back to a JS group-by since TypeORM doesn't emit DISTINCT ON.
    // Row count = messages across selected tickets, capped by page size,
    // so this stays cheap.
    const byTicket = new Map<string, EmailMessage>();
    for (const m of rows) {
      const existing = byTicket.get(m.ticket_id);
      if (!existing || existing.createdAt < m.createdAt) {
        byTicket.set(m.ticket_id, m);
      }
    }
    return byTicket;
  }
}

/**
 * Map (prevRole, nextRole) → the activity event that best describes
 * the assignee change.
 */
function pickAssigneeEvent(
  prevRole: UserRole | null,
  nextRole: UserRole,
): TicketActivity {
  if (nextRole === UserRole.BOT) {
    return prevRole && prevRole !== UserRole.BOT
      ? TicketActivity.SENT_BACK_TO_QUEUE
      : TicketActivity.ASSIGNED_TO_BOT;
  }
  // Assigning to a human agent
  if (prevRole === UserRole.BOT || prevRole === null) {
    return TicketActivity.ASSIGNED_TO_AGENT;
  }
  return TicketActivity.REASSIGNED_TO_AGENT;
}

/**
 * Map a status transition to its activity event.
 */
function pickStatusEvent(
  prev: TicketStatus,
  next: TicketStatus,
): TicketActivity {
  if (next === TicketStatus.IN_FOLLOWUP)
    return TicketActivity.PUT_INTO_FOLLOWUP;
  if (next === TicketStatus.WAITING) return TicketActivity.PUT_INTO_WAITING;
  if (next === TicketStatus.RESOLVED) return TicketActivity.MARKED_RESOLVED;
  // next === OPEN
  if (prev === TicketStatus.RESOLVED) return TicketActivity.REOPENED;
  return TicketActivity.SENT_BACK_TO_QUEUE;
}

/**
 * DTO validation already enforces the shape; this is defensive de-dup
 * + trim so the DB representation stays canonical regardless of
 * whitespace quirks in the incoming payload.
 */
function normaliseTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
