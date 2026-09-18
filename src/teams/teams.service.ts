import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { TicketStatus, UserRole } from '../database/enums';
import { Ticket } from '../tickets/entities/ticket.entity';
import { User } from '../users/entities/user.entity';
import type { CreateTeamDto } from './dto/create-team.dto';
import type { AddMemberDto, UpdateMemberDto } from './dto/team-member.dto';
import {
  TeamDetail,
  TeamResponse,
  toTeamDetail,
  toTeamResponse,
} from './dto/team-response.dto';
import type { UpdateTeamDto } from './dto/update-team.dto';
import { TeamMember } from './entities/team-member.entity';
import { Team } from './entities/team.entity';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class TeamsService {
  constructor(
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    @InjectRepository(TeamMember)
    private readonly members: Repository<TeamMember>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
  ) {}

  async list(): Promise<TeamResponse[]> {
    const rows = await this.teams.find({
      order: { is_default: 'DESC', createdAt: 'ASC' },
    });
    if (rows.length === 0) return [];
    // Batch-fetch counts so we don't N+1
    const counts = await this.members
      .createQueryBuilder('m')
      .select('m.team_id', 'team_id')
      .addSelect('COUNT(*)', 'count')
      .where('m.team_id IN (:...ids)', { ids: rows.map((t) => t.id) })
      .groupBy('m.team_id')
      .getRawMany<{ team_id: string; count: string }>();
    const byId = new Map(counts.map((c) => [c.team_id, Number(c.count)]));
    return rows.map((t) => toTeamResponse(t, byId.get(t.id) ?? 0));
  }

  async get(id: string): Promise<TeamDetail> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException('Team not found');
    const members = await this.members.find({
      where: { team_id: id },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    const openCounts = await this.countOpenTicketsPerMember(id);
    return toTeamDetail(team, members, openCounts);
  }

  /**
   * How many OPEN tickets each member of this team currently holds
   * inside the team. Used by the admin UI to render capacity usage
   * as `openInTeam / max` alongside the cap editor.
   */
  private async countOpenTicketsPerMember(
    teamId: string,
  ): Promise<Map<string, number>> {
    const rows: Array<{ assignee: string; count: string }> = await this.tickets
      .createQueryBuilder('t')
      .select('t.assignee', 'assignee')
      .addSelect('COUNT(*)', 'count')
      .where('t.team_id = :teamId', { teamId })
      .andWhere('t.status = :status', { status: TicketStatus.OPEN })
      .andWhere('t."deletedAt" IS NULL')
      .groupBy('t.assignee')
      .getRawMany();
    return new Map(rows.map((r) => [r.assignee, Number(r.count)]));
  }

  async create(dto: CreateTeamDto): Promise<TeamResponse> {
    try {
      const created = await this.teams.save(
        this.teams.create({ name: dto.name, is_default: false }),
      );
      // BOT is a first-class fallback member on every team so
      // admins can toggle it just like any other agent. Idempotent
      // via ON CONFLICT so a re-create after a partial failure is
      // fine.
      await this.autoAddBot(created.id);
      const count = await this.countMembers(created.id);
      return toTeamResponse(created, count);
    } catch (err) {
      throw translateUniqueError(err);
    }
  }

  /**
   * Ensures every existing BOT user is a member of the given team.
   * Called after team creation; the migration handles the same
   * backfill for pre-existing teams.
   */
  private async autoAddBot(teamId: string): Promise<void> {
    const bots = await this.users.find({ where: { role: UserRole.BOT } });
    for (const bot of bots) {
      try {
        await this.members.save(
          this.members.create({ team_id: teamId, user_id: bot.id }),
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  async update(id: string, dto: UpdateTeamDto): Promise<TeamResponse> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException('Team not found');

    const patch: Partial<Team> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.assignmentPaused !== undefined) {
      patch.assignment_paused = dto.assignmentPaused;
    }
    if (Object.keys(patch).length === 0) {
      return toTeamResponse(team, await this.countMembers(id));
    }

    try {
      await this.teams.update({ id }, patch);
    } catch (err) {
      throw translateUniqueError(err);
    }
    const updated = await this.teams.findOneOrFail({ where: { id } });
    return toTeamResponse(updated, await this.countMembers(id));
  }

  async remove(id: string): Promise<void> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.is_default) {
      throw new BadRequestException(
        'The default team cannot be deleted — every ticket needs somewhere to land.',
      );
    }
    await this.teams.delete({ id });
  }

  async addMember(id: string, dto: AddMemberDto): Promise<TeamDetail> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException('Team not found');
    const user = await this.users.findOne({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException('User not found');
    try {
      await this.members.save(
        this.members.create({
          team_id: id,
          user_id: dto.userId,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Already a member — idempotent no-op.
      } else {
        throw err;
      }
    }
    return this.get(id);
  }

  async removeMember(id: string, userId: string): Promise<TeamDetail> {
    const result = await this.members.delete({ team_id: id, user_id: userId });
    if (!result.affected) {
      throw new NotFoundException('That user is not in this team');
    }
    return this.get(id);
  }

  async updateMember(
    id: string,
    userId: string,
    dto: UpdateMemberDto,
  ): Promise<TeamDetail> {
    if (
      dto.pausedInTeam === undefined &&
      dto.maxConcurrentTickets === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }
    const patch: Partial<TeamMember> = {};
    if (dto.pausedInTeam !== undefined) patch.paused_in_team = dto.pausedInTeam;
    if (dto.maxConcurrentTickets !== undefined) {
      patch.max_concurrent_tickets = dto.maxConcurrentTickets;
    }
    const result = await this.members.update(
      { team_id: id, user_id: userId },
      patch,
    );
    if (!result.affected) {
      throw new NotFoundException('That user is not in this team');
    }
    return this.get(id);
  }

  async getDefault(): Promise<Team> {
    const team = await this.teams.findOne({ where: { is_default: true } });
    if (!team) {
      throw new NotFoundException(
        'No default team is configured — the General team seed must have failed',
      );
    }
    return team;
  }

  private async countMembers(teamId: string): Promise<number> {
    return this.members.count({ where: { team_id: teamId } });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
  );
}

function translateUniqueError(err: unknown): Error {
  if (isUniqueViolation(err)) {
    return new ConflictException('A team with that name already exists.');
  }
  return err as Error;
}
