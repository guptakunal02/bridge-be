import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateChannelDto } from './dto/create-channel.dto';
import type { SetCredentialsDto } from './dto/set-credentials.dto';
import type { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ChannelResponse,
  toChannelResponse,
} from './dto/channel-response.dto';
import { EmailCredentialsService } from './email/email-credentials.service';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailCredentials: EmailCredentialsService,
  ) {}

  async list(): Promise<ChannelResponse[]> {
    const rows = await this.prisma.channel.findMany({
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map(toChannelResponse);
  }

  async get(id: string): Promise<ChannelResponse> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    return toChannelResponse(channel);
  }

  async create(dto: CreateChannelDto): Promise<ChannelResponse> {
    try {
      const created = await this.prisma.channel.create({
        data: {
          type: dto.type,
          displayName: dto.displayName,
          inbox_contact: dto.inboxContact ?? null,
        },
      });
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
          credentials_encrypted: envelope,
          // Rotating creds invalidates any prior verification — the frontend
          // should surface the Test button again once rebuilt.
          credentialsVerifiedAt: null,
        },
      });
      return toChannelResponse(updated);
    }
    throw new BadRequestException(
      `Credentials management is not implemented for ${channel.type} channels`,
    );
  }
}

/**
 * Convert Prisma's P2002 unique-constraint error on Channel into a
 * user-friendly ConflictException.
 */
function translateChannelUniqueError(err: unknown): Error {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return err as Error;
  }
  return new ConflictException(
    'An inbox with this display name already exists. Pick a different name.',
  );
}
