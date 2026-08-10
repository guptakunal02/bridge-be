import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentRole, ChannelType, Prisma } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import { ChannelAdapterRegistry } from './adapters/channel-adapter.registry';
import {
  CHANNEL_EVENTS,
  ChannelDeletedEvent,
  ChannelSavedEvent,
} from './channel-events';
import { EmailCredentialsService } from './email/email-credentials.service';
import type { CreateChannelDto } from './dto/create-channel.dto';
import type { SetCredentialsDto } from './dto/set-credentials.dto';
import type { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ChannelAssignmentResponse,
  ChannelResponse,
  toChannelResponse,
} from './dto/channel-response.dto';

export interface CredentialsTestResult {
  smtp: { ok: boolean; error?: string };
  imap: { ok: boolean; error?: string };
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ChannelAdapterRegistry,
    private readonly emailCredentials: EmailCredentialsService,
    private readonly events: EventEmitter2,
  ) {}

  private emitSaved(channelId: string): void {
    const payload: ChannelSavedEvent = { channelId };
    this.events.emit(CHANNEL_EVENTS.Saved, payload);
  }

  private emitDeleted(channelId: string): void {
    const payload: ChannelDeletedEvent = { channelId };
    this.events.emit(CHANNEL_EVENTS.Deleted, payload);
  }

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
      this.emitSaved(created.id);
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
      this.emitSaved(updated.id);
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
      this.emitDeleted(id);
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

  async setCredentials(
    id: string,
    dto: SetCredentialsDto,
  ): Promise<ChannelResponse> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');

    if (channel.type === ChannelType.EMAIL) {
      if (!dto.email) {
        throw new BadRequestException(
          'Email credentials required for EMAIL channel',
        );
      }
      const envelope = this.emailCredentials.seal(dto.email);
      const updated = await this.prisma.channel.update({
        where: { id },
        data: { credentialsEncrypted: envelope },
      });
      this.emitSaved(updated.id);
      return toChannelResponse(updated);
    }
    throw new BadRequestException(
      `Credentials management is not implemented for ${channel.type} channels`,
    );
  }

  async testCredentials(id: string): Promise<CredentialsTestResult> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException(
        'Only EMAIL channels support credential testing',
      );
    }
    if (!channel.credentialsEncrypted) {
      throw new BadRequestException('No credentials saved on this channel yet');
    }

    const creds = this.emailCredentials.open(channel.credentialsEncrypted);
    const result: CredentialsTestResult = {
      smtp: { ok: false },
      imap: { ok: false },
    };

    try {
      const transporter = nodemailer.createTransport({
        host: creds.smtp.host,
        port: creds.smtp.port,
        secure: creds.smtp.secure,
        auth: { user: creds.smtp.username, pass: creds.smtp.password },
        connectionTimeout: 8000,
      });
      await transporter.verify();
      result.smtp.ok = true;
    } catch (err) {
      result.smtp.error = err instanceof Error ? err.message : String(err);
    }

    const imap = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: creds.imap.secure,
      auth: { user: creds.imap.username, pass: creds.imap.password },
      logger: false,
    });
    try {
      await imap.connect();
      const mailbox = await imap.mailboxOpen('INBOX');
      await imap.mailboxClose();
      result.imap.ok = Boolean(mailbox);
    } catch (err) {
      result.imap.error = err instanceof Error ? err.message : String(err);
    } finally {
      await imap.logout().catch(() => undefined);
    }

    return result;
  }
}
