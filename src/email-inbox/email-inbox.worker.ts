import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CHANNEL_EVENTS } from '../channels/channels.service';
import type {
  ChannelCredentialsSavedEvent,
  ChannelDeletedEvent,
  ChannelStatusChangedEvent,
} from '../channels/channels.service';
import { EmailCredentialsService } from '../channels/email/email-credentials.service';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelStatus, ChannelType } from '../database/enums';
import { EmailInboxService } from './email-inbox.service';
import { ImapConnection } from './providers/imap-connection';

/**
 * Orchestrates IMAP IDLE workers, one per EMAIL channel that has valid
 * saved credentials.
 *
 * Lifecycle:
 *   onModuleInit    → find every already-CONNECTED EMAIL channel with
 *                     credentials and start a worker for it
 *   onModuleDestroy → shut every worker down cleanly
 *
 * Reactive updates (via @OnEvent, wired from ChannelsService):
 *   channel.credentials.saved → restart the worker with the new creds
 *   channel.deleted           → stop the worker
 *   channel.status.changed    → start on CONNECTED / stop on DISCONNECTED
 */
@Injectable()
export class EmailInboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailInboxWorker.name);
  private readonly connections = new Map<string, ImapConnection>();

  constructor(
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    private readonly credentials: EmailCredentialsService,
    private readonly inbox: EmailInboxService,
  ) {}

  async onModuleInit(): Promise<void> {
    const eligible = await this.channels.find({
      where: {
        type: ChannelType.EMAIL,
        status: ChannelStatus.CONNECTED,
      },
    });

    for (const channel of eligible) {
      if (!channel.credentials_encrypted) continue;
      await this.startForChannel(channel.id).catch((err: Error) => {
        this.logger.error(
          `Failed to start IMAP for channel ${channel.id}: ${err.message}`,
        );
      });
    }

    this.logger.log(
      `IMAP IDLE workers running for ${this.connections.size} channel(s)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((c) => c.stop()),
    );
    this.connections.clear();
  }

  // ---- Event handlers (from ChannelsService) --------------------------

  @OnEvent(CHANNEL_EVENTS.CREDENTIALS_SAVED)
  async onCredentialsSaved(payload: ChannelCredentialsSavedEvent): Promise<void> {
    // Rotate: kill the old socket (if any) then start fresh
    await this.stopForChannel(payload.channelId);
    await this.startForChannel(payload.channelId).catch((err: Error) => {
      this.logger.error(
        `Restart after creds saved failed for ${payload.channelId}: ${err.message}`,
      );
    });
  }

  @OnEvent(CHANNEL_EVENTS.DELETED)
  async onDeleted(payload: ChannelDeletedEvent): Promise<void> {
    await this.stopForChannel(payload.channelId);
  }

  @OnEvent(CHANNEL_EVENTS.STATUS_CHANGED)
  async onStatusChanged(payload: ChannelStatusChangedEvent): Promise<void> {
    if (payload.status === ChannelStatus.DISCONNECTED) {
      await this.stopForChannel(payload.channelId);
    } else if (payload.status === ChannelStatus.CONNECTED) {
      await this.startForChannel(payload.channelId).catch((err: Error) => {
        this.logger.error(
          `Start on CONNECTED failed for ${payload.channelId}: ${err.message}`,
        );
      });
    }
  }

  // ---- Public API -----------------------------------------------------

  /**
   * Start (or no-op if already running) the IMAP worker for a channel.
   * Only EMAIL channels with saved credentials will actually connect.
   */
  async startForChannel(channelId: string): Promise<void> {
    if (this.connections.has(channelId)) return;

    const channel = await this.channels.findOne({ where: { id: channelId } });
    if (!channel) return;
    if (channel.type !== ChannelType.EMAIL) return;
    if (!channel.credentials_encrypted) return;

    const creds = this.credentials.open(channel.credentials_encrypted);
    const conn = new ImapConnection(
      channel.id,
      creds,
      this.inbox,
      this.logger,
    );
    await conn.start();
    this.connections.set(channel.id, conn);
  }

  async stopForChannel(channelId: string): Promise<void> {
    const conn = this.connections.get(channelId);
    if (!conn) return;
    await conn.stop();
    this.connections.delete(channelId);
  }
}
