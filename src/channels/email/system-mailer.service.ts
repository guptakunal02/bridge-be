import { Injectable, Logger } from '@nestjs/common';
import { ChannelStatus, ChannelType } from '@prisma/client';
import nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailCredentialsService } from './email-credentials.service';

export interface SystemMailerResult {
  ok: boolean;
  reason?: string;
}

/**
 * Sends outbound system-level email (invitations, notifications) using the
 * first CONNECTED EMAIL channel that has credentials, as the sender.
 *
 * "First" is deterministic (oldest CONNECTED channel) so admins can rely on
 * consistent From: address. If no eligible channel exists, sends no-op and
 * the caller falls back to copy-paste-the-link UX.
 *
 * Deliberately doesn't add new admin config surface — one env var / setting
 * per system feature is worse than reusing the channel the admin already
 * configured for customer conversations.
 */
@Injectable()
export class SystemMailer {
  private readonly logger = new Logger(SystemMailer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: EmailCredentialsService,
  ) {}

  async sendInvite(input: {
    to: string;
    acceptUrl: string;
    invitedBy: { name: string; email: string };
  }): Promise<SystemMailerResult> {
    const channel = await this.prisma.channel.findFirst({
      where: {
        type: ChannelType.EMAIL,
        status: ChannelStatus.CONNECTED,
        credentialsEncrypted: { not: null },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!channel || !channel.credentialsEncrypted) {
      return { ok: false, reason: 'no system sender configured' };
    }

    let creds;
    try {
      creds = this.credentials.open(channel.credentialsEncrypted);
    } catch (err) {
      this.logger.error(
        { err, channelId: channel.id },
        'system sender creds decrypt failed',
      );
      return { ok: false, reason: 'system sender credentials unreadable' };
    }

    const transporter = nodemailer.createTransport({
      host: creds.smtp.host,
      port: creds.smtp.port,
      secure: creds.smtp.secure,
      auth: { user: creds.smtp.username, pass: creds.smtp.password },
    });

    const subject = `${input.invitedBy.name} invited you to Bridge`;
    const text = [
      `Hi,`,
      ``,
      `${input.invitedBy.name} (${input.invitedBy.email}) invited you to join Bridge.`,
      ``,
      `Accept your invitation and set your password here:`,
      input.acceptUrl,
      ``,
      `This link expires in 7 days.`,
      ``,
      `— Bridge`,
    ].join('\n');
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; color:#1c1917; line-height:1.5;">
        <p>Hi,</p>
        <p><strong>${escapeHtml(input.invitedBy.name)}</strong>
           (<a href="mailto:${escapeHtml(input.invitedBy.email)}">${escapeHtml(input.invitedBy.email)}</a>)
           invited you to join <strong>Bridge</strong>.</p>
        <p>
          <a href="${input.acceptUrl}"
             style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">
            Accept invitation
          </a>
        </p>
        <p style="color:#78716c;font-size:13px;">Or paste this link into your browser:<br>
          <code style="font-size:12px;">${input.acceptUrl}</code>
        </p>
        <p style="color:#78716c;font-size:13px;">This link expires in 7 days.</p>
      </div>
    `.trim();

    try {
      await transporter.sendMail({
        from: `"${channel.displayName}" <${creds.address}>`,
        to: input.to,
        subject,
        text,
        html,
      });
      this.logger.log(
        { to: input.to, channelId: channel.id },
        'invite email sent',
      );
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, to: input.to }, 'invite email send failed');
      return { ok: false, reason };
    }
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
