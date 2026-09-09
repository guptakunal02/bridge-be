import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../database/entities';
import { ChannelType } from '../database/enums';
import type { CreateChannelDto } from './dto/create-channel.dto';
import type { SetCredentialsDto } from './dto/set-credentials.dto';
import type { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ChannelResponse,
  toChannelResponse,
} from './dto/channel-response.dto';
import { EmailCredentialsService } from './email/email-credentials.service';

// Postgres SQLSTATE for unique_violation — surfaced via the pg driver
// on QueryFailedError.driverError.code.
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class ChannelsService {
  constructor(
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly emailCredentials: EmailCredentialsService,
  ) {}

  async list(): Promise<ChannelResponse[]> {
    const rows = await this.channels.find({
      order: { createdAt: 'ASC' },
    });
    return rows.map(toChannelResponse);
  }

  async get(id: string): Promise<ChannelResponse> {
    const channel = await this.channels.findOne({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    return toChannelResponse(channel);
  }

  async create(dto: CreateChannelDto): Promise<ChannelResponse> {
    try {
      const created = await this.channels.save(
        this.channels.create({
          type: dto.type,
          displayName: dto.displayName,
          inbox_contact: dto.inboxContact ?? null,
        }),
      );
      return toChannelResponse(created);
    } catch (err) {
      throw translateChannelUniqueError(err);
    }
  }

  async update(id: string, dto: UpdateChannelDto): Promise<ChannelResponse> {
    const existing = await this.channels.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Channel not found');

    if (dto.displayName === undefined && dto.status === undefined) {
      return toChannelResponse(existing);
    }

    const data: Partial<Channel> = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      await this.channels.update({ id }, data);
    } catch (err) {
      throw translateChannelUniqueError(err);
    }
    const updated = await this.channels.findOneOrFail({ where: { id } });
    return toChannelResponse(updated);
  }

  async remove(id: string): Promise<void> {
    const result = await this.channels.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Channel not found');
    }
  }

  async setCredentials(
    id: string,
    dto: SetCredentialsDto,
  ): Promise<ChannelResponse> {
    const channel = await this.channels.findOne({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');

    if (channel.type === ChannelType.EMAIL) {
      if (!dto.email) {
        throw new BadRequestException(
          'Email credentials required for EMAIL channel',
        );
      }
      const envelope = this.emailCredentials.seal(dto.email);
      await this.channels.update(
        { id },
        {
          credentials_encrypted: envelope,
          // Rotating creds invalidates any prior verification — the frontend
          // should surface the Test button again once rebuilt.
          credentialsVerifiedAt: null,
        },
      );
      const updated = await this.channels.findOneOrFail({ where: { id } });
      return toChannelResponse(updated);
    }
    throw new BadRequestException(
      `Credentials management is not implemented for ${channel.type} channels`,
    );
  }
}

/**
 * Convert Postgres' unique_violation (SQLSTATE 23505), surfaced by
 * TypeORM as QueryFailedError, into a user-friendly ConflictException.
 */
function translateChannelUniqueError(err: unknown): Error {
  if (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
  ) {
    return new ConflictException(
      'An inbox with this display name already exists. Pick a different name.',
    );
  }
  return err as Error;
}
