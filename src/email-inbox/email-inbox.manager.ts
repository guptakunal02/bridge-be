import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Channel, ChannelStatus, ChannelType } from '@prisma/client';
import type {
  ChannelDeletedEvent,
  ChannelSavedEvent,
} from '../channels/channel-events';
import { CHANNEL_EVENTS } from '../channels/channel-events';
import { EmailAdapter } from '../channels/email/email.adapter';
import { EmailCredentialsService } from '../channels/email/email-credentials.service';
import { MessagesService } from '../conversations/messages.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailInboxWorker } from './email-inbox.worker';

/**
 * Owns the lifecycle of one EmailInboxWorker per EMAIL channel that is
 * CONNECTED and has credentials. Reacts to channel.saved / channel.deleted
 * events so worker set stays in sync with DB without polling.
 */
@Injectable()
export class EmailInboxManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailInboxManager.name);
  private readonly workers = new Map<string, EmailInboxWorker>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: EmailAdapter,
    private readonly credentials: EmailCredentialsService,
    private readonly messages: MessagesService,
  ) {}

  async onModuleInit(): Promise<void> {
    const channels = await this.prisma.channel.findMany({
      where: {
        type: ChannelType.EMAIL,
        status: ChannelStatus.CONNECTED,
        credentialsEncrypted: { not: null },
      },
    });
    if (channels.length === 0) {
      this.logger.log('no EMAIL channels to attach');
      return;
    }
    this.logger.log(`attaching ${channels.length} email inbox(es)`);
    for (const channel of channels) {
      await this.spawn(channel);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const stops = Array.from(this.workers.values()).map((w) => w.stop());
    this.workers.clear();
    await Promise.all(stops);
  }

  @OnEvent(CHANNEL_EVENTS.Saved)
  async onChannelSaved(payload: ChannelSavedEvent): Promise<void> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: payload.channelId },
    });
    if (!channel || channel.type !== ChannelType.EMAIL) return;

    // Stop any existing worker; credentials may have changed.
    await this.despawn(channel.id);

    const eligible =
      channel.status === ChannelStatus.CONNECTED &&
      channel.credentialsEncrypted !== null;
    if (eligible) {
      await this.spawn(channel);
    }
  }

  @OnEvent(CHANNEL_EVENTS.Deleted)
  async onChannelDeleted(payload: ChannelDeletedEvent): Promise<void> {
    await this.despawn(payload.channelId);
  }

  private async spawn(channel: Channel): Promise<void> {
    const worker = new EmailInboxWorker(
      channel,
      this.adapter,
      this.credentials,
      this.messages,
    );
    this.workers.set(channel.id, worker);
    await worker.start();
  }

  private async despawn(channelId: string): Promise<void> {
    const existing = this.workers.get(channelId);
    if (!existing) return;
    this.workers.delete(channelId);
    await existing.stop();
  }
}
