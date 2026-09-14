import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { UserRole } from '../database/enums';
import { User } from '../users/entities/user.entity';
import type { CreateTeamDto } from './dto/create-team.dto';
import type { AddMemberDto, SetMemberPauseDto } from './dto/team-member.dto';
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
    return toTeamDetail(team, members);
  }

  async create(dto: CreateTeamDto): Promise<TeamResponse> {
    try {
      const created = await this.teams.save(
        this.teams.create({ name: dto.name, is_default: false }),
      );
      return toTeamResponse(created, 0);
    } catch (err) {
      throw translateUniqueError(err);
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
    if (user.role === UserRole.BOT) {
      throw new BadRequestException('The BOT user cannot join a team');
    }
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

  async setMemberPause(
    id: string,
    userId: string,
    dto: SetMemberPauseDto,
  ): Promise<TeamDetail> {
    const result = await this.members.update(
      { team_id: id, user_id: userId },
      { paused_in_team: dto.pausedInTeam },
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
