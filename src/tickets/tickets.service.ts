import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { BotRuntimeService } from '../bot/runtime/bot-runtime.service';
import { Channel } from '../channels/entities/channel.entity';
import { EmailSenderService } from '../channels/email/email-sender.service';
import { Team } from '../teams/entities/team.entity';
import {
  BotTrigger,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { buildTicketContext } from '../rules/ticket-context';
import { TagsService } from '../tags/tags.service';
import { User } from '../users/entities/user.entity';
import { PresenceService } from '../users/presence.service';
import type { ListTicketsQuery, TicketScope } from './dto/list-tickets.dto';
import type { ReplyTicketDto } from './dto/reply-ticket.dto';
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
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly dataSource: DataSource,
    private readonly presence: PresenceService,
    private readonly runtime: BotRuntimeService,
    private readonly lifecycle: TicketLifecycleService,
    private readonly sender: EmailSenderService,
    private readonly tagsService: TagsService,
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
   *   teamQueueCount  — BOT-parked tickets in teams the caller is a
   *                     non-paused member of. NOT unscoped — a member
   *                     shouldn't see the queue of a team they aren't
   *                     part of, so this filters through team_member.
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

    // Scope by team_member: caller only counts BOT-parked tickets in
    // teams they're actually part of and haven't been paused from.
    // Zero if botId isn't seeded (defensive — shouldn't happen at MVP).
    const teamQueueCount = botId
      ? await this.tickets
          .createQueryBuilder('t')
          .innerJoin(
            'team_member',
            'tm',
            'tm.team_id = t.team_id AND tm.user_id = :userId AND tm.paused_in_team = false',
            { userId: actingUser.id },
          )
          .where('t.assignee = :botId', { botId })
          .andWhere('t.status IN (:...open)', { open: OPEN_STATUSES })
          .andWhere('t."deletedAt" IS NULL')
          .getCount()
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
   * Per-status counts respecting the same scope + channel filters as
   * `list`. Backs the "N behind each filter" counts on the inbox UI.
   * A single grouped SELECT with the same scope predicates — cheap
   * enough that we call it on every scope change.
   */
  async counts(
    query: ListTicketsQuery,
    actingUser: AuthenticatedUser,
  ): Promise<{
    all: number;
    open: number;
    in_followup: number;
    waiting: number;
    resolved: number;
  }> {
    const qb = this.tickets
      .createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.status');

    if (query.channelId) {
      qb.andWhere('t.channel_id = :channelId', { channelId: query.channelId });
    }
    await this.applyScope(qb, query.scope ?? 'all', actingUser);

    const rows: Array<{ status: TicketStatus; count: string }> =
      await qb.getRawMany();
    const by = new Map(rows.map((r) => [r.status, Number(r.count)]));
    const open = by.get(TicketStatus.OPEN) ?? 0;
    const in_followup = by.get(TicketStatus.IN_FOLLOWUP) ?? 0;
    const waiting = by.get(TicketStatus.WAITING) ?? 0;
    const resolved = by.get(TicketStatus.RESOLVED) ?? 0;
    return {
      all: open + in_followup + waiting + resolved,
      open,
      in_followup,
      waiting,
      resolved,
    };
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
      dto.teamId === undefined &&
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

      if (dto.teamId !== undefined && dto.teamId !== ticket.team_id) {
        // Force team change — bypasses routing rules on purpose so
        // admins can drop a mis-routed thread into the right queue.
        // Validate the target team exists so we surface a clean 404
        // instead of an FK violation.
        const teamRepo = mgr.getRepository(Team);
        const nextTeam = await teamRepo.findOne({ where: { id: dto.teamId } });
        if (!nextTeam) {
          throw new NotFoundException('Team not found');
        }
        patch.team_id = nextTeam.id;
        logs.push({
          event: TicketActivity.SENT_BACK_TO_QUEUE,
          log: `Team changed to "${nextTeam.name}" by ${actingUser.email ?? actingUser.id}`,
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
          // Any tag being ADDED must exist in the catalogue. We only
          // check the delta (added set) so removing an orphan tag
          // that predates the catalogue still works — otherwise
          // admins couldn't clean up historical tags.
          const added = nextTags.filter((t) => !prevTags.includes(t));
          if (added.length > 0) {
            const unknown = await this.tagsService.findUnknownNames(added, mgr);
            if (unknown.length > 0) {
              throw new BadRequestException(
                `Unknown tag${unknown.length === 1 ? '' : 's'}: ${unknown
                  .map((n) => `"${n}"`)
                  .join(', ')}. Ask an admin to add ${
                  unknown.length === 1 ? 'it' : 'them'
                } from the Tags page first.`,
              );
            }
          }
          patch.tags = nextTags;
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

  /**
   * Send an outbound reply from an agent. Flow:
   *
   *   1. Load the ticket, its channel, and every message on the
   *      thread (in date order) — the last inbound provides the
   *      In-Reply-To id, subject, and recipient; all inbound
   *      messages contribute to References.
   *   2. Fire the SMTP send (outside the txn — network I/O against
   *      third-party servers must never sit inside a DB txn).
   *   3. Persist the SENT EmailMessage row + AGENT_REPLIED activity
   *      inside a single txn once the send has succeeded. On send
   *      failure, nothing gets written — the FE surfaces the error
   *      and the agent retries.
   *
   * Ticket status is intentionally untouched: the agent chooses
   * separately whether to mark Waiting / Resolved etc. This keeps
   * the reply action's semantics predictable and avoids surprising
   * timer resets.
   */
  async reply(
    id: string,
    dto: ReplyTicketDto,
    actingUser: AuthenticatedUser,
  ): Promise<TicketDetail> {
    const ticket = await this.tickets.findOne({ where: { id } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === TicketStatus.RESOLVED) {
      throw new BadRequestException(
        'This ticket is Resolved — reopen it before replying.',
      );
    }

    const channel = await this.channels.findOne({
      where: { id: ticket.channel_id },
    });
    if (!channel) {
      throw new NotFoundException('Ticket channel no longer exists');
    }

    // Ordered oldest → newest. Cheap: bounded by messages-per-thread
    // which is dozens at most in practice.
    const thread = await this.emails.find({
      where: { ticket_id: id },
      order: { createdAt: 'ASC' },
    });
    const inbound = thread.filter((m) => m.type === MessageDirection.RECEIVED);
    const lastInbound = inbound[inbound.length - 1] ?? null;
    if (!lastInbound) {
      // A ticket with no inbound message is a data-integrity oddity
      // (email ingest always creates one). Reject rather than send
      // to nowhere.
      throw new BadRequestException(
        'This ticket has no inbound message to reply to.',
      );
    }

    const to = lastInbound.sender
      ? [lastInbound.sender]
      : (() => {
          throw new BadRequestException(
            'The last inbound message has no sender address on record.',
          );
        })();

    const subject = replySubject(lastInbound.subject);

    // References chain = every previous message's external id in
    // chronological order. Some MUAs (Outlook classic) require the
    // full chain, not just the immediate parent.
    const references = thread
      .map((m) => m.external_message_id)
      .filter((s): s is string => Boolean(s));

    // 1. SMTP send (outside the txn).
    const { externalMessageId } = await this.sender.sendReply({
      channel,
      to,
      subject,
      body: dto.body,
      bodyHtml: dto.bodyHtml ?? null,
      inReplyTo: lastInbound.external_message_id,
      references,
    });

    // 2. Persist message row + activity log in one txn.
    await this.dataSource.transaction(async (mgr) => {
      const emailRepo = mgr.getRepository(EmailMessage);
      const logRepo = mgr.getRepository(TicketActivityLog);

      await emailRepo.save(
        emailRepo.create({
          channelId: ticket.channel_id,
          ticket_id: id,
          type: MessageDirection.SENT,
          subject,
          content: dto.body,
          content_html: dto.bodyHtml ?? null,
          sender: channel.inbox_contact,
          receiver: to,
          external_message_id: externalMessageId,
        }),
      );
      await logRepo.save({
        ticket_id: id,
        event: TicketActivity.AGENT_REPLIED,
        actor_id: actingUser.id,
        log: `Replied to ${to.join(', ')} by ${actingUser.email ?? actingUser.id}`,
      });
    });

    try {
      await this.presence.slideOnActivity(actingUser.id);
    } catch {
      // presence slide is telemetry-adjacent; safe to swallow.
    }

    return this.get(id);
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
   * Fetch the newest EmailMessage for each ticket id in a single
   * round trip. Uses Postgres' `DISTINCT ON` — one row per ticket
   * via the existing (ticket_id, createdAt) index in a single
   * backward scan. Prior implementation loaded every message for
   * every listed ticket and picked the max in JS, which on 10
   * tickets with multi-message threads was pulling hundreds of
   * rows and driving the ticket list past 3 seconds.
   */
  private async fetchLatestMessages(
    ticketIds: string[],
  ): Promise<Map<string, EmailMessage>> {
    if (ticketIds.length === 0) return new Map();
    // ticket_id is bigint on the entity — TypeORM returns it as a
    // string, which is what the map key is compared against
    // downstream, so we don't cast either side.
    const rows: EmailMessage[] = await this.emails.query(
      `SELECT DISTINCT ON (ticket_id) *
         FROM email_message
        WHERE ticket_id = ANY($1::bigint[])
          AND "deletedAt" IS NULL
        ORDER BY ticket_id, "createdAt" DESC`,
      [ticketIds],
    );
    return new Map(rows.map((r) => [String(r.ticket_id), r]));
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

/**
 * Build the outbound Subject: prepend "Re: " unless the original
 * already starts with one (case-insensitive). Empty / null falls
 * back to a neutral "Support reply" so the mail isn't rejected by
 * strict MTAs.
 */
function replySubject(original: string | null): string {
  const trimmed = (original ?? '').trim();
  if (!trimmed) return 'Support reply';
  if (/^re:\s/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}
