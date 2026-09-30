import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { BotRuntimeService } from '../bot/runtime/bot-runtime.service';
import { Channel } from '../channels/entities/channel.entity';
import { EmailSenderService } from '../channels/email/email-sender.service';
import { S3StorageService } from '../common/storage/s3-storage.service';
import { TagRequirementService } from './tag-requirement.service';
import { Team } from '../teams/entities/team.entity';
import {
  BotTrigger,
  ChannelType,
  MessageDirection,
  TicketActivity,
  TicketStatus,
  UserRole,
} from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { EmailMessageAttachment } from '../email-inbox/entities/email-message-attachment.entity';
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
import { TicketReadState } from './entities/ticket-read-state.entity';
import { normaliseAddressList, replySubject } from './reply-utils';
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
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketActivityLog)
    private readonly activity: Repository<TicketActivityLog>,
    @InjectRepository(EmailMessage)
    private readonly emails: Repository<EmailMessage>,
    @InjectRepository(TicketReadState)
    private readonly readStates: Repository<TicketReadState>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly dataSource: DataSource,
    private readonly presence: PresenceService,
    private readonly runtime: BotRuntimeService,
    private readonly lifecycle: TicketLifecycleService,
    private readonly sender: EmailSenderService,
    private readonly tagsService: TagsService,
    private readonly storage: S3StorageService,
    private readonly tagRequirement: TagRequirementService,
  ) {}

  /**
   * Upload a single reply attachment to S3 and return the metadata
   * the FE hands back on Send. Ticket existence is verified so a
   * bogus id can't be used to burn S3 quota; no DB row is written
   * here — the persisted EmailMessageAttachment is created inside
   * the reply() txn once send succeeds.
   */
  async uploadReplyAttachment(
    ticketId: string,
    file: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
  ): Promise<{
    storageKey: string;
    storageUrl: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }> {
    const ticket = await this.tickets.findOne({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    const uploaded = await this.storage.upload({
      filename: file.originalname,
      contentType: file.mimetype,
      body: file.buffer,
    });
    return {
      storageKey: uploaded.key,
      storageUrl: uploaded.url,
      filename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
    };
  }

  async list(
    query: ListTicketsQuery,
    actingUser: AuthenticatedUser,
  ): Promise<TicketListItem[]> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = query.offset ?? 0;

    // sortBy = 'latest' (default) → order by the newest email_message
    //   row on the ticket (or ticket.createdAt if it has no messages
    //   yet). A customer reply bumps the ticket to the top; a
    //   silent status/tag/assignee change does NOT — those bump
    //   ticket.updatedAt but not the message stream, and this list
    //   label is "Latest message", not "latest mutation."
    // sortBy = 'created' → order by ticket.createdAt DESC. Newly
    //   opened tickets sit at the top regardless of later activity.
    // NB: raw .limit()/.offset() instead of .take()/.skip(). take()
    // wraps the whole query in a subquery to keep pagination correct
    // in the face of one-to-many joins — but that outer wrapper
    // strips the `t` alias, so our raw ORDER BY expression below
    // can't resolve `t."createdAt"`. All our joins here are
    // many-to-one (assignee + team, one row each per ticket), so
    // limit/offset is safe.
    const qb = this.tickets
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.assigneeUser', 'assignee')
      .leftJoinAndSelect('t.team', 'team')
      .limit(limit)
      .offset(offset);
    if (query.sortBy === 'created') {
      qb.orderBy('t.createdAt', 'DESC');
    } else {
      // Correlated subquery per row — MVP scale (thousands of
      // tickets tops) makes this fine; if the row count grows a
      // materialised `last_message_at` on ticket keeps the same
      // sort key without the subquery per row.
      qb.orderBy(
        `COALESCE((SELECT MAX(m."createdAt") FROM email_message m WHERE m.ticket_id = t.id), t."createdAt")`,
        'DESC',
      );
    }

    // Multi-value filters win over the legacy singular ones — the
    // FE always uses the plurals; the singulars stick around for
    // external callers hitting the endpoint directly.
    if (query.statuses && query.statuses.length > 0) {
      qb.andWhere('t.status IN (:...statuses)', {
        statuses: query.statuses,
      });
    } else if (query.status) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    if (query.channelIds && query.channelIds.length > 0) {
      qb.andWhere('t.channel_id IN (:...channelIds)', {
        channelIds: query.channelIds,
      });
    } else if (query.channelId) {
      qb.andWhere('t.channel_id = :channelId', { channelId: query.channelId });
    }
    if (query.assigneeIds && query.assigneeIds.length > 0) {
      qb.andWhere('t.assignee IN (:...assigneeIds)', {
        assigneeIds: query.assigneeIds,
      });
    }
    applyMessageSearch(qb, query.q);
    await this.applyScope(qb, query.scope ?? 'all', actingUser);

    const rows = await qb.getMany();
    if (rows.length === 0) return [];

    // Unread counts are per-assignee — only meaningful when the row
    // belongs to the caller. Filter the ids we query for so an admin
    // browsing all tickets doesn't get unread numbers computed
    // against their own read state on someone else's row. Non-mine
    // tickets get unreadCount: 0 in the response.
    const myTicketIds = rows
      .filter((t) => t.assignee === actingUser.id)
      .map((t) => t.id);
    const [latestByTicket, unreadByTicket] = await Promise.all([
      this.fetchLatestMessages(rows.map((t) => t.id)),
      this.unreadCountsFor(myTicketIds, actingUser.id),
    ]);
    return rows.map((t) =>
      toTicketListItem(
        t,
        latestByTicket.get(t.id) ?? null,
        unreadByTicket.get(t.id) ?? 0,
      ),
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

    if (query.channelIds && query.channelIds.length > 0) {
      qb.andWhere('t.channel_id IN (:...channelIds)', {
        channelIds: query.channelIds,
      });
    } else if (query.channelId) {
      qb.andWhere('t.channel_id = :channelId', { channelId: query.channelId });
    }
    if (query.assigneeIds && query.assigneeIds.length > 0) {
      qb.andWhere('t.assignee IN (:...assigneeIds)', {
        assigneeIds: query.assigneeIds,
      });
    }
    // NOTE: status filters are intentionally NOT applied to the
    // counts endpoint — the count-by-status is the whole point of
    // this response, so applying a status filter would collapse
    // every row to zero except the picked one.
    applyMessageSearch(qb, query.q);
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

  /**
   * All tickets from the same customer as the given ticket, newest
   * first. Identifies "the customer" by the sender of the earliest
   * RECEIVED message on the ticket — same rule the sidebar uses for
   * the Customer field. Excludes the current ticket from the list
   * (no point rendering "this ticket" in a jump list of others).
   *
   * Capped at 50 rows — a real customer with more than that is a
   * pathological case we can page through later if it comes up.
   */
  async listRelatedForCustomer(
    ticketId: string,
  ): Promise<
    import('./dto/ticket-response.dto').RelatedTicketSummary[]
  > {
    // Two-step because Postgres wants scalar subqueries when we mix
    // window functions with joins on the same message table — cleaner
    // to just resolve the customer email first, then a plain SELECT.
    const customerRow: Array<{ sender: string | null }> = await this.emails
      .query(
        `SELECT sender
           FROM public.email_message
          WHERE ticket_id = $1
            AND type = 'RECEIVED'
            AND "deletedAt" IS NULL
          ORDER BY "createdAt" ASC
          LIMIT 1`,
        [ticketId],
      );
    const customerEmail = customerRow[0]?.sender;
    if (!customerEmail) return [];

    // DISTINCT ON keeps one row per ticket while joining email_message.
    // Subject comes from the earliest message on each ticket so it
    // matches the header the ticket detail page shows.
    const rows: Array<{
      id: string;
      status: TicketStatus;
      is_reopened: boolean;
      channel_type: ChannelType;
      createdAt: Date;
      updatedAt: Date;
      subject: string | null;
    }> = await this.emails.query(
      `SELECT DISTINCT ON (t.id)
              t.id, t.status, t.is_reopened, t.channel_type,
              t."createdAt", t."updatedAt",
              (SELECT m2.subject
                 FROM public.email_message m2
                WHERE m2.ticket_id = t.id
                  AND m2."deletedAt" IS NULL
                ORDER BY m2."createdAt" ASC
                LIMIT 1) AS subject
         FROM public.ticket t
         INNER JOIN public.email_message m
                 ON m.ticket_id = t.id
                AND m."deletedAt" IS NULL
                AND m.type = 'RECEIVED'
                AND m.sender = $1
        WHERE t.id <> $2
          AND t."deletedAt" IS NULL
        ORDER BY t.id, t."updatedAt" DESC
        LIMIT 50`,
      [customerEmail, ticketId],
    );
    // The DISTINCT ON pass sorted by ticket id (Postgres requires the
    // dedupe column to lead the ORDER BY). Re-sort by updatedAt DESC
    // for the FE list order.
    rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      isReopened: r.is_reopened,
      channelType: r.channel_type,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Bump last_read_at for (user, ticket) ONLY when the user is the
   * current assignee. Read state is a per-assignee affordance — an
   * admin drilling into someone else's ticket shouldn't inadvertently
   * mark it read for the assignee. Upsert is atomic; no race with
   * concurrent opens.
   */
  async markRead(ticketId: string, userId: string): Promise<void> {
    const ticket = await this.tickets.findOne({
      where: { id: ticketId },
      select: { id: true, assignee: true },
    });
    if (!ticket || ticket.assignee !== userId) return;
    await this.readStates
      .createQueryBuilder()
      .insert()
      .into(TicketReadState)
      .values({
        user_id: userId,
        ticket_id: ticketId,
        last_read_at: () => 'now()',
      })
      .orUpdate(['last_read_at', 'updatedAt'], ['user_id', 'ticket_id'])
      .execute();
  }

  /**
   * Batch unread counts for a set of ticket ids, for one user. Only
   * counts RECEIVED (inbound) messages that arrived after the user's
   * last read timestamp — outbound replies the user just sent aren't
   * "new to me". Missing read-state rows mean "never opened", which
   * counts every inbound message on the ticket.
   *
   * Returns a map keyed by ticket id → count (defaults to 0 if the
   * ticket had no inbound activity for this user).
   */
  private async unreadCountsFor(
    ticketIds: string[],
    userId: string,
  ): Promise<Map<string, number>> {
    if (ticketIds.length === 0) return new Map();
    const rows: Array<{ ticket_id: string; unread: string }> =
      await this.emails.query(
        `SELECT m.ticket_id, COUNT(*)::text AS unread
           FROM public.email_message m
           LEFT JOIN public.ticket_read_state rs
                  ON rs.ticket_id = m.ticket_id
                 AND rs.user_id = $1
          WHERE m.ticket_id = ANY($2::bigint[])
            AND m."deletedAt" IS NULL
            AND m.type = 'RECEIVED'
            AND (rs.last_read_at IS NULL
                 OR m."createdAt" > rs.last_read_at)
          GROUP BY m.ticket_id`,
        [userId, ticketIds],
      );
    return new Map(rows.map((r) => [String(r.ticket_id), Number(r.unread)]));
  }

  async get(id: string): Promise<TicketDetail> {
    const ticket = await this.tickets.findOne({
      where: { id },
      relations: { assigneeUser: true, team: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    // Walk previous_ticket_id backwards to collect the ancestor chain
    // so the detail view can render the full conversation with a
    // "New ticket started here" divider between each ancestor and
    // the next. Chain length is bounded in practice (customer replies
    // → resolve → past-window continuation, N cycles); cap at 20
    // defensively so a pathological loop can't stall the request.
    const chainIds = await this.collectAncestorChain(id, 20);

    const [messages, activity] = await Promise.all([
      // Ancestor messages come along too — the FE groups by ticketId
      // and inserts a divider at each boundary. Ordering by createdAt
      // works because ancestor tickets resolved before the current
      // one was created, so message timestamps stay monotonic across
      // the chain.
      this.emails.find({
        where: { ticket_id: In(chainIds) },
        relations: { attachments: true },
        order: { createdAt: 'ASC' },
      }),
      // Activity log stays scoped to THIS ticket. Ancestor activity
      // is operational (assignments, timers, etc.) and belongs to
      // each ticket individually.
      this.activity.find({
        where: { ticket_id: id },
        order: { createdAt: 'ASC' },
      }),
    ]);

    return toTicketDetail(ticket, messages, activity);
  }

  /**
   * Returns [id, previous_ticket_id, ancestor_of_previous, …] up to
   * `maxDepth`. Guards against cycles by tracking seen ids — a
   * malformed chain terminates cleanly instead of spinning forever.
   */
  private async collectAncestorChain(
    startId: string,
    maxDepth: number,
  ): Promise<string[]> {
    const seen = new Set<string>([startId]);
    const out: string[] = [startId];
    let cursor: string | null = startId;
    while (out.length < maxDepth && cursor !== null) {
      const row = await this.tickets.findOne({
        where: { id: cursor },
        select: { id: true, previous_ticket_id: true },
      });
      const prev = row?.previous_ticket_id ?? null;
      if (prev === null || seen.has(prev)) break;
      seen.add(prev);
      out.push(prev);
      cursor = prev;
    }
    return out;
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

    // "Require tag before closing" workspace policy. Enforced here
    // at the service layer so every caller — HTTP PATCH, bulk update,
    // any future webhook / job / script — hits the same rule.
    // Setting-off path is a fast short-circuit; the checker only
    // reads the ticket when the setting is on AND the target is a
    // closing transition.
    await this.tagRequirement.assertSatisfied(
      id,
      dto as unknown as Record<string, unknown>,
    );

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

      // Tag-requirement policy already asserted above the transaction
      // via TagRequirementService — nothing to check inside the txn.

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

        // resolved_at bookkeeping. Set on the write that enters
        // RESOLVED so the ingest path can cheaply gate its
        // "reopen if reply within window" rule; clear on any
        // transition away so a stale timestamp can't trip us up
        // if the ticket is closed and reopened multiple times.
        if (dto.status === TicketStatus.RESOLVED) {
          patch.resolved_at = new Date();
        } else if (ticket.status === TicketStatus.RESOLVED) {
          patch.resolved_at = null;
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

        // waiting_action bookkeeping: required on WAITING transitions
        // (so the sweep knows what to do), forbidden elsewhere, cleared
        // on any transition away from WAITING.
        if (dto.status === TicketStatus.WAITING) {
          if (dto.waitingAction === undefined) {
            throw new BadRequestException(
              'waitingAction is required when moving a ticket to WAITING',
            );
          }
          patch.waiting_action = dto.waitingAction;
        } else {
          if (dto.waitingAction !== undefined) {
            throw new BadRequestException(
              'waitingAction only applies to WAITING transitions',
            );
          }
          patch.waiting_action = null;
        }

        logs.push({
          event,
          log: buildTransitionLog(
            ticket.status,
            dto.status,
            actingUser.email ?? actingUser.id,
            dto.resumeAtHours,
            dto.waitingAction,
          ),
        });
      } else if (dto.resumeAtHours !== undefined) {
        // Sent without an accompanying status change — nothing to
        // do here; the FE only ever pairs it with a WAITING/FOLLOWUP
        // transition. Rather than silently accept, be loud.
        throw new BadRequestException(
          `resumeAtHours only applies to WAITING or IN_FOLLOWUP transitions`,
        );
      } else if (dto.waitingAction !== undefined) {
        throw new BadRequestException(
          'waitingAction only applies to WAITING transitions',
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
              // Latest received message on the ticket, if any; else
              // the ticket's own createdAt as a sensible fallback.
              latestCustomerMessageAt: lastReceivedMsgAt(detail),
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
   * Apply the same patch to a batch of tickets. Best-effort:
   * each ticket runs update() in its own txn, so a single row
   * failing (already-terminal status, missing team, etc.) doesn't
   * roll back the rest. The response lists successes + per-ticket
   * failure reasons so the FE can show a partial-success toast.
   *
   * Tag semantics: `addTags` is unioned onto each ticket's
   * existing tag set — set-with-union rather than replace, since
   * a bulk operation should never silently erase per-ticket tags.
   */
  async bulkUpdate(
    dto: import('./dto/bulk-update-tickets.dto').BulkUpdateTicketsDto,
    actingUser: AuthenticatedUser,
  ): Promise<
    import('./dto/bulk-update-tickets.dto').BulkUpdateResult
  > {
    // Load the current tags for every requested ticket in one round
    // trip so we can compute per-ticket union without one SELECT per
    // patch when the caller supplied addTags.
    const tagOverlay = new Map<string, string[]>();
    if (dto.addTags && dto.addTags.length > 0) {
      const rows = await this.tickets.find({
        where: { id: In(dto.ticketIds) },
        select: { id: true, tags: true },
      });
      for (const r of rows) tagOverlay.set(r.id, r.tags ?? []);
    }

    const succeeded: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];

    for (const id of dto.ticketIds) {
      try {
        const perTicketPatch: {
          status?: TicketStatus;
          assigneeId?: string;
          teamId?: string;
          tags?: string[];
        } = {};
        if (dto.status !== undefined) perTicketPatch.status = dto.status;
        if (dto.assigneeId !== undefined)
          perTicketPatch.assigneeId = dto.assigneeId;
        if (dto.teamId !== undefined) perTicketPatch.teamId = dto.teamId;
        if (dto.addTags && dto.addTags.length > 0) {
          const existing = tagOverlay.get(id) ?? [];
          const merged = Array.from(new Set([...existing, ...dto.addTags]));
          perTicketPatch.tags = merged;
        }
        if (Object.keys(perTicketPatch).length === 0) {
          failed.push({ id, reason: 'No fields to update' });
          continue;
        }
        // Tag-requirement policy fires inside update() — the
        // surrounding try/catch routes any BadRequestException
        // (tagless close under the setting) into `failed[]` instead
        // of tanking the batch. Mixed batches surface per-ticket
        // rejections cleanly.
        await this.update(id, perTicketPatch, actingUser);
        succeeded.push(id);
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : 'Unknown error';
        failed.push({ id, reason });
      }
    }

    return { succeeded, failed };
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

    // Normalise CC / BCC:
    //   - lowercase + trim so dedupe is real
    //   - drop anything that duplicates the primary To
    //   - enforce a combined cap (matches the FE-declared "20 total")
    // BCC intentionally NOT persisted on the timeline — that's its
    // whole point. CC gets appended to the receiver array so the
    // timeline shows every visible recipient of the outbound.
    const cc = normaliseAddressList(dto.cc, to);
    const bcc = normaliseAddressList(dto.bcc, [...to, ...cc]);
    if (cc.length + bcc.length > 20) {
      throw new BadRequestException(
        'Combined CC + BCC recipients cannot exceed 20 addresses.',
      );
    }

    // 1. SMTP send (outside the txn). The sender re-derives each
    //    attachment's URL server-side from `storageKey`, so a
    //    malicious storageUrl on the DTO can't influence the SMTP
    //    fetch path — the FE-supplied URL is only used for on-disk
    //    persistence below (and is derived from the same key).
    const { externalMessageId } = await this.sender.sendReply({
      channel,
      to,
      cc,
      bcc,
      subject,
      body: dto.body,
      bodyHtml: dto.bodyHtml ?? null,
      inReplyTo: lastInbound.external_message_id,
      references,
      attachments: (dto.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        storageKey: a.storageKey,
      })),
    });

    // 2. Persist message row + attachments + activity log in one txn.
    //    If persist fails after send, the customer already got the
    //    email — write a compensating activity row via a fresh
    //    connection so admins can spot the divergence.
    try {
      await this.dataSource.transaction(async (mgr) => {
        const emailRepo = mgr.getRepository(EmailMessage);
        const attachmentRepo = mgr.getRepository(EmailMessageAttachment);
        const logRepo = mgr.getRepository(TicketActivityLog);

        const savedMessage = await emailRepo.save(
          emailRepo.create({
            channelId: ticket.channel_id,
            ticket_id: id,
            type: MessageDirection.SENT,
            subject,
            content: dto.body,
            content_html: dto.bodyHtml ?? null,
            sender: channel.inbox_contact,
            // Store every visible recipient on the timeline row. BCC
            // stays out on purpose (invisible by definition).
            receiver: [...to, ...cc],
            external_message_id: externalMessageId,
          }),
        );

        if (dto.attachments && dto.attachments.length > 0) {
          await attachmentRepo.save(
            dto.attachments.map((a) =>
              attachmentRepo.create({
                message_id: savedMessage.id,
                filename: a.filename,
                content_type: a.contentType,
                size_bytes: String(a.sizeBytes),
                storage_key: a.storageKey,
                storage_url: a.storageUrl,
              }),
            ),
          );
        }

        const recipientSummary = [...to, ...cc, ...bcc].join(', ');
        await logRepo.save({
          ticket_id: id,
          event: TicketActivity.AGENT_REPLIED,
          actor_id: actingUser.id,
          log: `Replied to ${recipientSummary} by ${actingUser.email ?? actingUser.id}`,
        });
      });
    } catch (persistErr) {
      const errMsg =
        persistErr instanceof Error ? persistErr.message : String(persistErr);
      this.logger.error(
        `SMTP send succeeded but DB persist failed. ticket=${id} externalMessageId=${externalMessageId} error=${errMsg}`,
      );
      // Best-effort compensating log so the audit trail flags the
      // divergence even when the primary write failed. If even this
      // fails, we swallow — the original error is the important one.
      try {
        await this.activity.save({
          ticket_id: id,
          event: TicketActivity.AGENT_REPLIED,
          actor_id: actingUser.id,
          log: `SMTP send succeeded but DB persist failed. External Message-ID: ${externalMessageId}. Error: ${errMsg}`,
        });
      } catch {
        // ignore
      }
      throw persistErr;
    }

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
    // Role check: `all` and `unassigned` are admin-only surfaces.
    // A member sending scope=all could otherwise pull the whole
    // workspace's tickets — the FE never sends it for members, but
    // this is the actual enforcement point (never trust the client).
    if (scope !== 'mine' && actingUser.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        `scope=${scope} is admin-only. Use scope=mine.`,
      );
    }
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
/**
 * Latest RECEIVED (inbound) message timestamp on the ticket detail,
 * falling back to the ticket's own createdAt when there are no
 * inbound messages yet (system-created shells, or a Bridge-side
 * outbound-first fluke). Used to feed routing rules that key off
 * `latest_customer_message.hour_ist`.
 */
function lastReceivedMsgAt(detail: {
  createdAt: string;
  messages: Array<{ direction: import('../database/enums').MessageDirection; createdAt: string }>;
}): Date {
  for (let i = detail.messages.length - 1; i >= 0; i--) {
    const m = detail.messages[i]!;
    if (m.direction === 'RECEIVED') return new Date(m.createdAt);
  }
  return new Date(detail.createdAt);
}

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
 * Build the free-text `log` field on the status-transition activity
 * row. For WAITING / IN_FOLLOWUP transitions we splice in the
 * chosen duration (and, for WAITING, whether the sweep will auto-
 * resolve or reopen). That way an admin scrolling the activity
 * timeline reads "for 2h" without cross-referencing the ticket's
 * resume_at field, which cleared the moment the timer fired.
 */
function buildTransitionLog(
  prev: TicketStatus,
  next: TicketStatus,
  actor: string,
  resumeAtHours: number | undefined,
  waitingAction: import('../database/enums').WaitingAction | undefined,
): string {
  const base = `Status ${prev} → ${next}`;
  if (
    (next === TicketStatus.WAITING || next === TicketStatus.IN_FOLLOWUP) &&
    resumeAtHours !== undefined
  ) {
    const duration = formatDurationHours(resumeAtHours);
    const tail =
      next === TicketStatus.WAITING && waitingAction
        ? ` (then ${waitingAction === 'REOPEN' ? 'reopens' : 'auto-resolves'})`
        : '';
    return `${base} for ${duration}${tail} by ${actor}`;
  }
  return `${base} by ${actor}`;
}

/**
 * Human-readable duration for a decimal hours input. `2` → "2h",
 * `1.5` → "1h 30m", `0.25` → "15m". Rounds to the nearest minute
 * because the picker offers minute-level granularity.
 */
function formatDurationHours(hours: number): string {
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
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
 * Attach a "search this ticket's messages" predicate to the given
 * ticket query builder. Matches case-insensitive substrings on
 * sender OR subject across every email_message belonging to the
 * ticket — EXISTS keeps it a semi-join so tickets don't multiply
 * when multiple messages match.
 *
 * No-op for empty / whitespace-only strings; callers can safely
 * pass through unfiltered inputs.
 *
 * Performance note: no functional indexes on sender/subject today,
 * so this scans email_message for each query. Fine at MVP scale
 * (thousands of rows); add pg_trgm + GIN indexes if the inbox
 * grows past ~50k messages.
 */
function applyMessageSearch(
  qb: import('typeorm').SelectQueryBuilder<import('./entities/ticket.entity').Ticket>,
  raw: string | undefined,
): void {
  const q = raw?.trim();
  if (!q) return;

  // If the query looks like a ticket id ("831" or "#831") we OR-in
  // an exact-id predicate. Substring text search stays in place so
  // typing "831" on a ticket whose subject mentions "Order #831"
  // still surfaces that ticket too. Non-numeric input skips the id
  // branch entirely.
  const idCandidate = q.replace(/^#/, '');
  const isNumericId = /^\d+$/.test(idCandidate);

  if (isNumericId) {
    qb.andWhere(
      `(
         t.id::text = :bridgeIdExact
         OR EXISTS (
           SELECT 1 FROM public.email_message m
            WHERE m.ticket_id = t.id
              AND m."deletedAt" IS NULL
              AND (m.sender ILIKE :bridgeQ OR m.subject ILIKE :bridgeQ)
         )
       )`,
      { bridgeIdExact: idCandidate, bridgeQ: `%${q}%` },
    );
  } else {
    qb.andWhere(
      `EXISTS (
         SELECT 1 FROM public.email_message m
          WHERE m.ticket_id = t.id
            AND m."deletedAt" IS NULL
            AND (m.sender ILIKE :bridgeQ OR m.subject ILIKE :bridgeQ)
       )`,
      { bridgeQ: `%${q}%` },
    );
  }
}

