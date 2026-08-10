import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  OnModuleInit,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelAdapterRegistry } from '../channels/adapters/channel-adapter.registry';
import type { EnvVars } from '../config/env.validation';
import { NodeEnv } from '../config/env.validation';
import { MessagesService } from '../conversations/messages.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DEV-ONLY endpoint that simulates Meta's Instagram messaging webhook.
 * Guarded at boot: if NODE_ENV === 'production' the route is a 404 (the
 * controller throws in onModuleInit if reachable in prod).
 *
 * Payload shape mirrors what InstagramStubAdapter.translateInbound expects:
 *   {
 *     "channelId": "<uuid>",
 *     "events": [
 *       {
 *         "contactId": "ig_alice_123",
 *         "contactName": "Alice",
 *         "messageId": "ig_msg_...",
 *         "text": "hey!"
 *       }
 *     ]
 *   }
 *
 * Phase 7 will add the REAL /webhooks/instagram (challenge verify, HMAC sig
 * check, Meta payload translation).
 */
@Controller('webhooks/instagram/stub')
export class InstagramStubController implements OnModuleInit {
  private readonly logger = new Logger(InstagramStubController.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly registry: ChannelAdapterRegistry,
    private readonly messages: MessagesService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (this.config.get('NODE_ENV', { infer: true }) === NodeEnv.Production) {
      this.logger.warn(
        'InstagramStubController is enabled in production — this is a dev-only endpoint',
      );
    }
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(@Body() body: unknown): Promise<{
    accepted: number;
    conversationIds: string[];
  }> {
    if (this.config.get('NODE_ENV', { infer: true }) === NodeEnv.Production) {
      throw new NotFoundException();
    }

    const adapter = this.registry.get(ChannelType.INSTAGRAM);
    if (!adapter) {
      throw new ServiceUnavailableException(
        'Instagram adapter is not registered',
      );
    }

    const channelId =
      typeof body === 'object' && body !== null && 'channelId' in body
        ? (body as { channelId?: unknown }).channelId
        : undefined;
    if (typeof channelId !== 'string') {
      throw new BadRequestException('channelId is required');
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, type: true },
    });
    if (!channel || channel.type !== ChannelType.INSTAGRAM) {
      throw new BadRequestException(
        'channelId does not refer to an INSTAGRAM channel',
      );
    }

    const events = await adapter.translateInbound(body);
    const conversationIds: string[] = [];
    for (const event of events) {
      const persisted = await this.messages.ingestInbound(event);
      if (!conversationIds.includes(persisted.conversationId)) {
        conversationIds.push(persisted.conversationId);
      }
    }
    return { accepted: events.length, conversationIds };
  }
}
