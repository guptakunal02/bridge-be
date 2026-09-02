import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChannelType, Prisma, UserRole } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
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

  async list(actor: AuthenticatedUser): Promise<ChannelResponse[]> {
    const where =
      actor.role === UserRole.ADMIN
        ? {}
        : { assignments: { some: { userId: actor.id } } };

    const rows = await this.prisma.channel.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map(toChannelResponse);
  }

  async get(id: string, actor: AuthenticatedUser): Promise<ChannelResponse> {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      include:
        actor.role === UserRole.ADMIN
          ? undefined
          : {
              assignments: {
                where: { userId: actor.id },
                select: { userId: true },
              },
            },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    if (actor.role !== UserRole.ADMIN) {
      const withAssignments = channel as typeof channel & {
        assignments: { userId: string }[];
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
      throw translateChannelUniqueError(err);
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
      throw translateChannelUniqueError(err);
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

    const rows = await this.prisma.userChannel.findMany({
      where: { channelId: id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      userId: r.userId,
      channelId: r.channelId,
      assignedByUserId: r.assignedByUserId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async assignUsers(
    channelId: string,
    userIds: string[],
    assignedBy: AuthenticatedUser,
  ): Promise<ChannelAssignmentResponse[]> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, deactivatedAt: true },
    });
    if (users.length !== userIds.length) {
      throw new BadRequestException('One or more users not found');
    }
    const inactive = users.filter((u) => u.deactivatedAt !== null);
    if (inactive.length > 0) {
      throw new BadRequestException(
        `Cannot assign deactivated users: ${inactive.map((u) => u.id).join(', ')}`,
      );
    }

    await this.prisma.$transaction(
      userIds.map((userId) =>
        this.prisma.userChannel.upsert({
          where: { userId_channelId: { userId, channelId } },
          update: {},
          create: { userId, channelId, assignedByUserId: assignedBy.id },
        }),
      ),
    );

    return this.listAssignments(channelId);
  }

  async unassignUser(channelId: string, userId: string): Promise<void> {
    try {
      await this.prisma.userChannel.delete({
        where: { userId_channelId: { userId, channelId } },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('User is not assigned to this channel');
      }
      throw err;
    }
  }

  // Used internally by other modules (Phase 5 assignment engine, Phase 3
  // conversation scoping). Not exposed over HTTP.
  getChannelIdsForUser(userId: string): Promise<string[]> {
    return this.prisma.userChannel
      .findMany({ where: { userId }, select: { channelId: true } })
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
        data: {
          credentialsEncrypted: envelope,
          mailboxAddress: dto.email.smtp.username,
          // Rotating creds invalidates any prior OTP verification — the
          // frontend should surface the Test button again.
          credentialsVerifiedAt: null,
        },
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

/**
 * Convert Prisma's P2002 unique-constraint error on Channel into a
 * user-friendly ConflictException. `err.meta.target` names the failing
 * index so we can differentiate displayName vs (type, externalId).
 */
function translateChannelUniqueError(err: unknown): Error {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return err as Error;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  if (fields.some((f) => f.toLowerCase().includes('displayname'))) {
    return new ConflictException(
      'An inbox with this display name already exists. Pick a different name.',
    );
  }
  return new ConflictException(
    'A channel of this type with the same externalId already exists.',
  );
}
