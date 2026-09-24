import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { S3StorageService } from '../../common/storage/s3-storage.service';
import { Channel } from '../entities/channel.entity';
import { EmailCredentialsService } from './email-credentials.service';

/**
 * Parameters for a single outbound reply. The caller (tickets
 * service) resolves the ticket + channel + thread context and hands
 * this shape over — the sender stays stateless.
 */
export interface OutboundEmailAttachment {
  filename: string;
  contentType: string;
  /**
   * S3 object key inside our own attachments/ prefix. The sender
   * downloads bytes server-side and hands nodemailer `content:
   * Buffer` — that means the FE never gets to influence what URL
   * the SMTP relay fetches, closing the SSRF surface that a raw
   * `path: <URL>` would open.
   */
  storageKey: string;
}

export interface OutboundEmailReply {
  channel: Channel;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  /**
   * External Message-ID of the last INBOUND message on this thread,
   * if any. Used for In-Reply-To + References so MUAs stitch the
   * reply back into the same visual thread.
   */
  inReplyTo?: string | null;
  /**
   * Prior messages' external ids, oldest → newest. Included as the
   * References header (RFC 5322 §3.6.4) so long threads chain cleanly.
   * Cheap to build from EmailMessage rows on the ticket.
   */
  references?: string[];
  /**
   * Files to inline as SMTP attachments. Empty / undefined → no
   * attachments part on the message.
   */
  attachments?: OutboundEmailAttachment[];
}

export interface OutboundEmailResult {
  /** nodemailer-generated Message-ID (angle-bracket-wrapped). */
  externalMessageId: string;
}

/**
 * Owns nodemailer transport creation + the actual SMTP send. Kept
 * separate from EmailCredentialsService so the credential envelope
 * layer stays free of protocol concerns.
 *
 * Transport is created per-send. Reusing a pool across requests
 * would be a small perf win but risks silent connection death on
 * long-lived processes — the trade-off isn't worth it at MVP scale.
 */
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);

  constructor(
    private readonly credentials: EmailCredentialsService,
    private readonly storage: S3StorageService,
  ) {}

  async sendReply(input: OutboundEmailReply): Promise<OutboundEmailResult> {
    const envelope = input.channel.credentials_encrypted;
    if (!envelope) {
      throw new BadRequestException(
        'This channel has no SMTP credentials configured. Set them in Inboxes → Credentials before replying.',
      );
    }

    const creds = this.credentials.open(envelope);
    const transport: Transporter<SMTPTransport.SentMessageInfo> =
      nodemailer.createTransport({
        host: creds.smtp.host,
        port: creds.smtp.port,
        secure: creds.smtp.secure,
        auth: {
          user: creds.smtp.username,
          pass: creds.smtp.password,
        },
      });

    // From honours the channel's configured display name so replies
    // land as "Support <support@…>" rather than the raw address.
    const from = input.channel.displayName
      ? `"${input.channel.displayName}" <${creds.address}>`
      : creds.address;

    // Threading headers. nodemailer accepts inReplyTo/references as
    // top-level fields — they get serialised into the RFC headers.
    // Recipients' MUAs stitch on these two combined.
    const info: SMTPTransport.SentMessageInfo = await transport.sendMail({
      from,
      to: input.to,
      cc: input.cc && input.cc.length > 0 ? input.cc : undefined,
      bcc: input.bcc && input.bcc.length > 0 ? input.bcc : undefined,
      subject: input.subject,
      text: input.body,
      html: input.bodyHtml ?? undefined,
      inReplyTo: input.inReplyTo ?? undefined,
      references:
        input.references && input.references.length > 0
          ? input.references
          : undefined,
      // Fetch each object into memory and hand nodemailer a Buffer.
      // Sequential to keep the peak memory footprint bounded (10
      // attachments × 25 MB cap = ≤ 250 MB worst case); parallelising
      // wouldn't save wall-clock on the SMTP-bound path anyway.
      attachments: await this.materialiseAttachments(input.attachments),
    });

    // Close the socket promptly; reusing across requests is riskier
    // than the small per-send cost.
    transport.close();

    if (!info.messageId) {
      // Nodemailer always returns a messageId in practice, but the
      // type is `string | undefined`. Fail loudly rather than persist
      // a broken external_message_id that future threading would miss.
      this.logger.error(
        `SMTP send returned no Message-ID (channel=${input.channel.id})`,
      );
      throw new Error('SMTP transport did not return a Message-ID');
    }

    return { externalMessageId: info.messageId };
  }

  /**
   * Download each attachment's bytes from S3 and pack them into the
   * shape nodemailer wants. `storageKey` is validated by the storage
   * service (must live under attachments/) so a malformed reference
   * bounces here rather than reaching the SMTP relay.
   */
  private async materialiseAttachments(
    inputs: OutboundEmailAttachment[] | undefined,
  ): Promise<
    | Array<{ filename: string; contentType: string; content: Buffer }>
    | undefined
  > {
    if (!inputs || inputs.length === 0) return undefined;
    const out: Array<{ filename: string; contentType: string; content: Buffer }> =
      [];
    for (const a of inputs) {
      const { body } = await this.storage.download(a.storageKey);
      out.push({
        filename: a.filename,
        contentType: a.contentType,
        content: body,
      });
    }
    return out;
  }
}
