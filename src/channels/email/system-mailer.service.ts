import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ChannelStatus, ChannelType } from '../../database/enums';
import type { EnvVars } from '../../config/env.validation';
import { Channel } from '../entities/channel.entity';
import { EmailSenderService } from './email-sender.service';

/**
 * Sends workspace-issued, non-thread emails (invites now, future
 * notifications later) through the workspace's own connected inbox.
 *
 * No external SES/SendGrid dependency — we reuse the OAuth-wired
 * transport that already delivers customer replies. Sender is
 * picked deterministically: the oldest CONNECTED EMAIL channel with
 * credentials wins. First run is stable, and adding more inboxes
 * later doesn't silently swap the From: address.
 */
@Injectable()
export class SystemMailerService {
  private readonly logger = new Logger(SystemMailerService.name);

  constructor(
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    private readonly sender: EmailSenderService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /**
   * Send the invite email to a newly-added teammate. Best effort:
   * returns true on delivery, false if no eligible sender channel
   * exists or the send itself failed. Never throws — the caller
   * treats the row-create as the source of truth and uses the
   * boolean only to shape the admin's toast copy.
   */
  async sendInvite(input: {
    to: string;
    inviteeName: string;
    inviterName: string;
    role: 'MEMBER' | 'ADMIN';
  }): Promise<boolean> {
    const sender = await this.pickSenderChannel();
    if (!sender) {
      this.logger.warn(
        `No eligible CONNECTED EMAIL channel to send invite to ${input.to}`,
      );
      return false;
    }

    const frontend = this.config.get('FRONTEND_ORIGIN', { infer: true });
    const subject = `You've been invited to Bridge`;
    const { text, html } = renderInviteEmail({
      inviteeName: input.inviteeName,
      inviterName: input.inviterName,
      role: input.role,
      // The marketing landing page has the "Sign in with Google" CTA
      // that kicks off the OAuth flow. No dedicated /sign-in route.
      signInUrl: `${frontend}/`,
      inviteEmail: input.to,
    });

    try {
      await this.sender.sendSystem({
        channel: sender,
        to: [input.to],
        subject,
        body: text,
        bodyHtml: html,
      });
      return true;
    } catch (err) {
      // Log-and-swallow: the User row already exists, so the admin
      // can still onboard the invitee out of band. Surface via the
      // response boolean.
      this.logger.error(
        `Failed to send invite email to ${input.to}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private pickSenderChannel(): Promise<Channel | null> {
    return this.channels.findOne({
      where: {
        type: ChannelType.EMAIL,
        status: ChannelStatus.CONNECTED,
        credentials_encrypted: Not(IsNull()),
      },
      order: { createdAt: 'ASC' },
    });
  }
}

/**
 * Minimal, well-tested HTML shell — one CTA, no external assets so
 * every mail client renders it identically. Plain-text mirror is
 * generated inline so clients that strip HTML still get the URL.
 */
function renderInviteEmail(v: {
  inviteeName: string;
  inviterName: string;
  role: 'MEMBER' | 'ADMIN';
  signInUrl: string;
  inviteEmail: string;
}): { text: string; html: string } {
  const roleCopy =
    v.role === 'ADMIN'
      ? 'as an admin — you can manage the team, channels, and every ticket'
      : 'as a member — you’ll handle tickets assigned to you';

  const text = [
    `Hi ${v.inviteeName},`,
    ``,
    `${v.inviterName} has invited you to join Bridge, the SURMA customer-support workspace, ${roleCopy}.`,
    ``,
    `Sign in with your Google account (${v.inviteEmail}) here:`,
    v.signInUrl,
    ``,
    `If the email above isn’t the Google account you use, ask ${v.inviterName} to re-invite the right address.`,
    ``,
    `— Bridge`,
  ].join('\n');

  const safe = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:32px;">
        <tr><td>
          <p style="margin:0 0 20px 0;font-size:14px;color:#78716c;">Bridge · SURMA</p>
          <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:600;">You’ve been invited</h1>
          <p style="margin:0 0 20px 0;font-size:14px;line-height:1.55;">
            Hi ${safe(v.inviteeName)}, ${safe(v.inviterName)} has invited you to join Bridge ${roleCopy}.
          </p>
          <p style="margin:0 0 24px 0;font-size:14px;line-height:1.55;">
            Sign in with the Google account <strong>${safe(v.inviteEmail)}</strong> to land straight in the inbox.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr><td style="background:#4f46e5;border-radius:8px;">
              <a href="${v.signInUrl}"
                 style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
                Sign in to Bridge
              </a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0 0;font-size:12px;color:#78716c;line-height:1.55;">
            Or paste this into your browser:<br>
            <a href="${v.signInUrl}" style="color:#4f46e5;word-break:break-all;">${v.signInUrl}</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#78716c;line-height:1.55;">
            If the email address above isn’t your Google account, ask ${safe(v.inviterName)} to re-invite you at the right address.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { text, html };
}
