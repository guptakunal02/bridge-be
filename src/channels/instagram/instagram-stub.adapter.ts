import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type {
  ChannelAdapter,
  InboundEvent,
  SendMessageInput,
  SendMessageResult,
} from '../adapters/channel-adapter.port';

/**
 * Development-mode adapter for INSTAGRAM. It doesn't talk to Meta:
 * - sendMessage returns a fake externalMessageId so agents see SENT.
 * - translateInbound accepts a permissive stub payload used by the
 *   POST /webhooks/instagram/stub endpoint (added in Phase 6).
 *
 * Replaced by a real Meta Graph adapter in Phase 7.
 */
@Injectable()
export class InstagramStubAdapter implements ChannelAdapter {
  readonly type: ChannelType = ChannelType.INSTAGRAM;
  private readonly logger = new Logger(InstagramStubAdapter.name);

  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const preview =
      input.payload.kind === 'TEXT'
        ? input.payload.text.slice(0, 80)
        : `[${input.payload.kind}] ${input.payload.mediaUrl}`;
    this.logger.log(
      `[stub-ig] → contact=${input.contact.externalId} conv=${input.conversationId}: ${preview}`,
    );
    return Promise.resolve({
      externalMessageId: `stub_ig_${randomUUID()}`,
      sentAt: new Date(),
    });
  }

  translateInbound(rawPayload: unknown): Promise<InboundEvent[]> {
    if (!this.isStubPayload(rawPayload)) return Promise.resolve([]);

    const events: InboundEvent[] = rawPayload.events.map((e) => ({
      kind: 'MESSAGE',
      channelId: rawPayload.channelId,
      externalContactId: e.contactId,
      externalContactName: e.contactName,
      externalContactAvatarUrl: e.contactAvatarUrl,
      externalMessageId: e.messageId,
      occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
      message: e.text
        ? { type: 'TEXT', text: e.text }
        : { type: 'IMAGE', mediaUrl: e.mediaUrl ?? '' },
    }));

    return Promise.resolve(events);
  }

  private isStubPayload(value: unknown): value is StubInboundPayload {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.channelId === 'string' && Array.isArray(v.events);
  }
}

interface StubInboundPayload {
  channelId: string;
  events: StubInboundEvent[];
}

interface StubInboundEvent {
  contactId: string;
  contactName?: string;
  contactAvatarUrl?: string;
  messageId: string;
  occurredAt?: string;
  text?: string;
  mediaUrl?: string;
}
