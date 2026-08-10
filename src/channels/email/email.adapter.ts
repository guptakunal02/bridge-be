import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, MessageDirection } from '@prisma/client';
import type { ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ChannelAdapter,
  InboundEvent,
  SendMessageInput,
  SendMessageResult,
} from '../adapters/channel-adapter.port';
import { EmailCredentialsService } from './email-credentials.service';

const SUBJECT_FALLBACK = 'Support reply';

/**
 * Real Email adapter. Talks SMTP (via nodemailer) for outbound and expects
 * mailparser ParsedMail objects for inbound (fed by EmailInboxManager in 8b).
 *
 * Threading strategy (V1):
 *   - Outbound sets In-Reply-To to the last INBOUND message's Message-ID
 *     (stored as Message.externalId).
 *   - Inbound events land in the conversation for the same contact address.
 *     Message.externalId = incoming Message-ID (so future outbound can thread).
 */
@Injectable()
export class EmailAdapter implements ChannelAdapter {
  readonly type: ChannelType = ChannelType.EMAIL;
  private readonly logger = new Logger(EmailAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: EmailCredentialsService,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (input.payload.kind !== 'TEXT') {
      throw new Error(
        `Email adapter currently supports TEXT only (got ${input.payload.kind})`,
      );
    }
    if (!input.channel.credentialsEncrypted) {
      throw new Error(
        `Email channel ${input.channel.id} has no credentials configured`,
      );
    }

    const creds = this.credentials.open(input.channel.credentialsEncrypted);

    const lastInbound = await this.prisma.message.findFirst({
      where: {
        conversationId: input.conversationId,
        direction: MessageDirection.INBOUND,
      },
      orderBy: { createdAt: 'desc' },
      select: { externalId: true, text: true },
    });

    const transporter = nodemailer.createTransport({
      host: creds.smtp.host,
      port: creds.smtp.port,
      secure: creds.smtp.secure,
      auth: { user: creds.smtp.username, pass: creds.smtp.password },
    });

    const subject = this.deriveSubject(lastInbound?.text ?? null);

    const info = await transporter.sendMail({
      from: `"${input.channel.displayName}" <${creds.address}>`,
      to: input.contact.externalId,
      subject,
      text: input.payload.text,
      inReplyTo: lastInbound?.externalId ?? undefined,
      references: lastInbound?.externalId
        ? [lastInbound.externalId]
        : undefined,
    });

    this.logger.log(
      {
        conversationId: input.conversationId,
        to: input.contact.externalId,
        messageId: info.messageId,
      },
      'email sent',
    );

    return {
      externalMessageId: info.messageId,
      sentAt: new Date(),
    };
  }

  translateInbound(rawPayload: unknown): Promise<InboundEvent[]> {
    if (!this.isParsedMail(rawPayload)) return Promise.resolve([]);
    const mail = rawPayload;

    const from = mail.from?.value?.[0];
    if (!from?.address) return Promise.resolve([]);

    if (!mail.messageId) return Promise.resolve([]);

    // The IMAP loop hands us the target channelId externally — encode it into
    // the payload as `__channelId` before calling translateInbound. This keeps
    // the adapter stateless (no channel context needed here).
    const channelId = (rawPayload as { __channelId?: unknown }).__channelId;
    if (typeof channelId !== 'string') return Promise.resolve([]);

    const text =
      (mail.text ?? '').trim() || (mail.html ? '(HTML message)' : '');
    if (!text) return Promise.resolve([]);

    return Promise.resolve([
      {
        kind: 'MESSAGE',
        channelId,
        externalContactId: from.address.toLowerCase(),
        externalContactName: from.name?.trim() || undefined,
        externalMessageId: mail.messageId,
        occurredAt: mail.date ?? new Date(),
        message: { type: 'TEXT', text },
      },
    ]);
  }

  private deriveSubject(lastInboundText: string | null): string {
    if (!lastInboundText) return SUBJECT_FALLBACK;
    // Naive: strip newlines, trim, cap to 60 chars, prefix Re:
    const cleaned = lastInboundText.replace(/\s+/g, ' ').trim().slice(0, 60);
    return cleaned ? `Re: ${cleaned}` : SUBJECT_FALLBACK;
  }

  private isParsedMail(value: unknown): value is ParsedMail {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return 'from' in v || 'messageId' in v || 'subject' in v;
  }
}
