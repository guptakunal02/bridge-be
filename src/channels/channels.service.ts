import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { Channel } from './entities/channel.entity';
import { ChannelStatus, ChannelType } from '../database/enums';
import { ChannelResponse, toChannelResponse } from './dto/channel-response.dto';
import type { CreateChannelDto } from './dto/create-channel.dto';
import type { SetCredentialsDto } from './dto/set-credentials.dto';
import type { UpdateChannelDto } from './dto/update-channel.dto';
import { EmailCredentialsService } from './email/email-credentials.service';

/**
 * Channel lifecycle events. Consumers (currently the IMAP IDLE worker
 * in email-inbox) subscribe via @OnEvent — this keeps ChannelsService
 * free of any downstream feature-module imports.
 */
export const CHANNEL_EVENTS = {
  CREDENTIALS_SAVED: 'channel.credentials.saved',
  DELETED: 'channel.deleted',
  STATUS_CHANGED: 'channel.status.changed',
} as const;

export interface ChannelCredentialsSavedEvent {
  channelId: string;
}
export interface ChannelDeletedEvent {
  channelId: string;
}
export interface ChannelStatusChangedEvent {
  channelId: string;
  status: ChannelStatus;
}

// Postgres SQLSTATE for unique_violation — surfaced via the pg driver
// on QueryFailedError.driverError.code.
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class ChannelsService {
  constructor(
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly emailCredentials: EmailCredentialsService,
    private readonly events: EventEmitter2,
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

    // Fire an event on real status transitions so the IMAP worker can
    // start / stop watching this inbox as needed.
    if (dto.status !== undefined && dto.status !== existing.status) {
      this.events.emit(CHANNEL_EVENTS.STATUS_CHANGED, {
        channelId: id,
        status: dto.status,
      } satisfies ChannelStatusChangedEvent);
    }

    return toChannelResponse(updated);
  }

  async remove(id: string): Promise<void> {
    const result = await this.channels.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Channel not found');
    }
    this.events.emit(CHANNEL_EVENTS.DELETED, {
      channelId: id,
    } satisfies ChannelDeletedEvent);
  }

  async setCredentials(
    id: string,
    dto: SetCredentialsDto,
  ): Promise<ChannelResponse> {
    // The old password-based path is gone. Email channels connect
    // exclusively via the OAuth flow now — see the OAuth authorize +
    // callback endpoints on this controller. This method stays for
    // future non-Gmail channel types (WhatsApp, Instagram) that'll
    // need their own credential shape.
    void dto;
    const channel = await this.channels.findOne({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type === ChannelType.EMAIL) {
      throw new BadRequestException(
        'Email channels connect via OAuth. Start the flow at GET /channels/:id/email/oauth/authorize.',
      );
    }
    throw new BadRequestException(
      `Credentials management is not implemented for ${channel.type} channels`,
    );
  }

  /**
   * Persist the tokens Google returned from the OAuth callback and
   * flip the channel to CONNECTED so the IMAP + Sent workers pick
   * it up on the next event tick.
   */
  async saveEmailOAuthCredentials(
    id: string,
    input: { address: string; refreshToken: string },
  ): Promise<ChannelResponse> {
    const channel = await this.channels.findOne({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException(
        'OAuth credentials only apply to EMAIL channels.',
      );
    }
    const envelope = this.emailCredentials.seal({
      address: input.address,
      refreshToken: input.refreshToken,
    });
    await this.channels.update(
      { id },
      {
        credentials_encrypted: envelope,
        inbox_contact: input.address,
        status: ChannelStatus.CONNECTED,
        credentialsVerifiedAt: new Date(),
      },
    );
    const updated = await this.channels.findOneOrFail({ where: { id } });
    this.events.emit(CHANNEL_EVENTS.CREDENTIALS_SAVED, {
      channelId: id,
    } satisfies ChannelCredentialsSavedEvent);
    return toChannelResponse(updated);
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
