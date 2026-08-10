import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AgentRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import { ChannelAdapterRegistry } from './adapters/channel-adapter.registry';
import type { CreateChannelDto } from './dto/create-channel.dto';
import type { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ChannelAssignmentResponse,
  ChannelResponse,
  toChannelResponse,
} from './dto/channel-response.dto';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ChannelAdapterRegistry,
  ) {}

  async list(actor: AuthenticatedAgent): Promise<ChannelResponse[]> {
    const where =
      actor.role === AgentRole.ADMIN
        ? {}
        : { assignments: { some: { agentId: actor.id } } };

    const rows = await this.prisma.channel.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map(toChannelResponse);
  }

  async get(id: string, actor: AuthenticatedAgent): Promise<ChannelResponse> {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      include:
        actor.role === AgentRole.ADMIN
          ? undefined
          : {
              assignments: {
                where: { agentId: actor.id },
                select: { agentId: true },
              },
            },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    if (actor.role !== AgentRole.ADMIN) {
      const withAssignments = channel as typeof channel & {
        assignments: { agentId: string }[];
      };
      if (withAssignments.assignments.length === 0) {
        throw new NotFoundException('Channel not found');
      }
    }
    return toChannelResponse(channel);
  }

  async create(dto: CreateChannelDto): Promise<ChannelResponse> {
    try {
      const created = await this.prisma.channel.create({
        data: {
          type: dto.type,
          displayName: dto.displayName,
          externalId: dto.externalId ?? null,
        },
      });
      return toChannelResponse(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A channel of this type with the same externalId already exists',
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateChannelDto): Promise<ChannelResponse> {
    if (dto.displayName === undefined && dto.status === undefined) {
      const existing = await this.prisma.channel.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Channel not found');
      return toChannelResponse(existing);
    }

    try {
      const updated = await this.prisma.channel.update({
        where: { id },
        data: {
          displayName: dto.displayName,
          status: dto.status,
        },
      });
      return toChannelResponse(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Channel not found');
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.channel.delete({ where: { id } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Channel not found');
      }
      throw err;
    }
  }

  async listAssignments(id: string): Promise<ChannelAssignmentResponse[]> {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const rows = await this.prisma.agentChannel.findMany({
      where: { channelId: id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      agentId: r.agentId,
      channelId: r.channelId,
      assignedByAgentId: r.assignedByAgentId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async assignAgents(
    channelId: string,
    agentIds: string[],
    assignedBy: AuthenticatedAgent,
  ): Promise<ChannelAssignmentResponse[]> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const agents = await this.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, deactivatedAt: true },
    });
    if (agents.length !== agentIds.length) {
      throw new BadRequestException('One or more agents not found');
    }
    const inactive = agents.filter((a) => a.deactivatedAt !== null);
    if (inactive.length > 0) {
      throw new BadRequestException(
        `Cannot assign deactivated agents: ${inactive.map((a) => a.id).join(', ')}`,
      );
    }

    await this.prisma.$transaction(
      agentIds.map((agentId) =>
        this.prisma.agentChannel.upsert({
          where: { agentId_channelId: { agentId, channelId } },
          update: {},
          create: { agentId, channelId, assignedByAgentId: assignedBy.id },
        }),
      ),
    );

    return this.listAssignments(channelId);
  }

  async unassignAgent(channelId: string, agentId: string): Promise<void> {
    try {
      await this.prisma.agentChannel.delete({
        where: { agentId_channelId: { agentId, channelId } },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Agent is not assigned to this channel');
      }
      throw err;
    }
  }

  // Used internally by other modules (Phase 5 assignment engine, Phase 3
  // conversation scoping). Not exposed over HTTP.
  getChannelIdsForAgent(agentId: string): Promise<string[]> {
    return this.prisma.agentChannel
      .findMany({ where: { agentId }, select: { channelId: true } })
      .then((rows) => rows.map((r) => r.channelId));
  }
}
