import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, MessageDirection } from '@prisma/client';
import { convert as htmlToText } from 'html-to-text';
import type { ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ChannelAdapter,
  InboundEvent,
  SendMessageInput,
  SendMessageResult,
} from '../adapters/channel-adapter.port';
import { normalizeEmailAddress } from './email-address';
import { EmailCredentialsService } from './email-credentials.service';

const SUBJECT_FALLBACK = 'Support reply';
const RE_PREFIX = /^\s*re\s*:/i;

interface EmailMessageMetadata {
  subject?: string;
}

/**
 * Real Email adapter. Talks SMTP (via nodemailer) for outbound and expects
 * mailparser ParsedMail objects for inbound (fed by EmailInboxManager).
 *
 * Threading strategy:
 *   - Outbound sets In-Reply-To to the last INBOUND message's Message-ID
 *     (stored as Message.externalId).
 *   - Outbound Subject reuses the original inbound Subject (from
 *     Message.metadata.subject), preserving the user's own "Re:" if already
 *     present. Falls back to a truncated preview of the body, then a generic
 *     fallback.
 *   - Inbound events use a normalised (trim + lowercase) From address as the
 *     stable Contact identifier. Message.externalId = incoming Message-ID.
 *   - HTML-only inbound is converted to plain text via html-to-text so agents
 *     always have readable context.
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
      select: { externalId: true, text: true, metadata: true },
    });

    const transporter = nodemailer.createTransport({
      host: creds.smtp.host,
      port: creds.smtp.port,
      secure: creds.smtp.secure,
      auth: { user: creds.smtp.username, pass: creds.smtp.password },
    });

    const subject = this.deriveSubject(lastInbound);

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

    const text = this.extractText(mail);
    if (!text) return Promise.resolve([]);

    const metadata: Record<string, string> = {};
    if (mail.subject && mail.subject.trim().length > 0) {
      metadata.subject = mail.subject.trim();
    }

    return Promise.resolve([
      {
        kind: 'MESSAGE',
        channelId,
        externalContactId: normalizeEmailAddress(from.address),
        externalContactName: from.name?.trim() || undefined,
        externalMessageId: mail.messageId,
        occurredAt: mail.date ?? new Date(),
        message: { type: 'TEXT', text },
        metadata,
      },
    ]);
  }

  private extractText(mail: ParsedMail): string {
    const plain = (mail.text ?? '').trim();
    if (plain) return plain;
    if (mail.html) {
      const converted = htmlToText(mail.html, {
        wordwrap: 100,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        ],
      }).trim();
      if (converted) return converted;
    }
    return '';
  }

  private deriveSubject(
    last: { text: string | null; metadata: unknown } | null,
  ): string {
    // Prefer the persisted Subject header from the customer's original message.
    const meta = this.readMetadata(last?.metadata);
    if (meta.subject) {
      return RE_PREFIX.test(meta.subject)
        ? meta.subject
        : `Re: ${meta.subject}`;
    }
    // Fallback: truncated preview of the customer's message body.
    if (last?.text) {
      const cleaned = last.text.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (cleaned) return `Re: ${cleaned}`;
    }
    return SUBJECT_FALLBACK;
  }

  private readMetadata(raw: unknown): EmailMessageMetadata {
    if (typeof raw !== 'object' || raw === null) return {};
    const obj = raw as Record<string, unknown>;
    const subject = obj.subject;
    return { subject: typeof subject === 'string' ? subject : undefined };
  }

  private isParsedMail(value: unknown): value is ParsedMail {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return 'from' in v || 'messageId' in v || 'subject' in v;
  }
}
