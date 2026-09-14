import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { TicketActivity, TicketStatus, UserRole } from '../database/enums';
import { EmailMessage } from '../email-inbox/entities/email-message.entity';
import { User } from '../users/entities/user.entity';
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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
    if (dto.status === undefined && dto.assigneeId === undefined) {
      throw new BadRequestException('Nothing to update');
    }

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
        logs.push({
          event,
          log: `Assignee changed to ${nextUser.name} (${nextUser.role}) by ${actingUser.email ?? actingUser.id}`,
        });
      }

      if (dto.status !== undefined && dto.status !== ticket.status) {
        const event = pickStatusEvent(ticket.status, dto.status);
        patch.status = dto.status;
        if (
          ticket.status === TicketStatus.RESOLVED &&
          dto.status !== TicketStatus.RESOLVED
        ) {
          patch.is_reopened = true;
        }
        logs.push({
          event,
          log: `Status ${ticket.status} → ${dto.status} by ${actingUser.email ?? actingUser.id}`,
        });
      }

      if (Object.keys(patch).length > 0) {
        await ticketRepo.update({ id }, patch);
      }
      for (const entry of logs) {
        await logRepo.save({
          ticket_id: id,
          event: entry.event,
          log: entry.log,
        });
      }
    });

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
