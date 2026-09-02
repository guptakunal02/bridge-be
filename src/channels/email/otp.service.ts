import { createHash, randomInt } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChannelStatus, ChannelType } from '@prisma/client';
import nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailCredentialsService } from './email-credentials.service';

export interface OtpStartResult {
  challengeId: string;
  sentToEmail: string;
  expiresAt: string;
}

export interface OtpVerifyResult {
  ok: true;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class ChannelOtpService {
  private readonly logger = new Logger(ChannelOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: EmailCredentialsService,
  ) {}

  async start(channelId: string, recipientEmail: string): Promise<OtpStartResult> {
    const channel = await this.loadEmailChannelWithCreds(channelId);

    // Invalidate any older un-verified challenges for this channel so a
    // spammy user can't stack them up.
    await this.prisma.emailChallenge.updateMany({
      where: { channelId, verifiedAt: null },
      data: { verifiedAt: new Date(0) },
    });

    const code = generateNumericCode(6);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    const created = await this.prisma.emailChallenge.create({
      data: {
        channelId,
        sentToEmail: recipientEmail,
        codeHash: hashCode(code),
        expiresAt,
      },
    });

    await this.sendOtpEmail(channel, recipientEmail, code);

    return {
      challengeId: created.id,
      sentToEmail: recipientEmail,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(
    channelId: string,
    challengeId: string,
    submittedCode: string,
  ): Promise<OtpVerifyResult> {
    const challenge = await this.prisma.emailChallenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge || challenge.channelId !== channelId) {
      throw new NotFoundException('OTP challenge not found');
    }
    if (challenge.verifiedAt !== null) {
      throw new BadRequestException('This OTP was already used');
    }
    if (challenge.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('OTP has expired. Request a new one.');
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      throw new ForbiddenException('Too many attempts. Request a new OTP.');
    }

    if (hashCode(submittedCode) !== challenge.codeHash) {
      await this.prisma.emailChallenge.update({
        where: { id: challengeId },
        data: { attempts: challenge.attempts + 1 },
      });
      throw new BadRequestException('Incorrect code');
    }

    await this.prisma.$transaction([
      this.prisma.emailChallenge.update({
        where: { id: challengeId },
        data: { verifiedAt: new Date() },
      }),
      this.prisma.channel.update({
        where: { id: channelId },
        data: { status: ChannelStatus.CONNECTED },
      }),
    ]);

    return { ok: true };
  }

  private async loadEmailChannelWithCreds(channelId: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.type !== ChannelType.EMAIL) {
      throw new BadRequestException('OTP test is only supported for EMAIL channels');
    }
    if (!channel.credentialsEncrypted) {
      throw new BadRequestException('Save credentials before running a test');
    }
    return channel;
  }

  private async sendOtpEmail(
    channel: { id: string; displayName: string; credentialsEncrypted: string | null },
    to: string,
    code: string,
  ): Promise<void> {
    if (!channel.credentialsEncrypted) {
      throw new BadRequestException('Save credentials before running a test');
    }
    const creds = this.credentials.open(channel.credentialsEncrypted);
    const transporter = nodemailer.createTransport({
      host: creds.smtp.host,
      port: creds.smtp.port,
      secure: creds.smtp.secure,
      auth: { user: creds.smtp.username, pass: creds.smtp.password },
      connectionTimeout: 10_000,
    });

    const subject = `Bridge inbox verification — ${code}`;
    const text = [
      `Your Bridge verification code is: ${code}`,
      ``,
      `Enter it in the Bridge dashboard to confirm this mailbox is`,
      `wired up correctly. The code expires in 10 minutes.`,
      ``,
      `— Bridge`,
    ].join('\n');
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; color:#1c1917; line-height:1.5;">
        <p>Your Bridge verification code is:</p>
        <p style="font-size:32px;font-weight:600;letter-spacing:4px;">${code}</p>
        <p>Enter it in the Bridge dashboard to confirm this mailbox is
           wired up correctly. The code expires in 10 minutes.</p>
      </div>
    `.trim();

    try {
      await transporter.sendMail({
        from: `"${channel.displayName}" <${creds.address}>`,
        to,
        subject,
        text,
        html,
      });
    } catch (err) {
      this.logger.warn(
        { err, channelId: channel.id, to },
        'OTP send failed',
      );
      throw new BadRequestException(
        err instanceof Error
          ? `SMTP send failed: ${err.message}`
          : 'SMTP send failed',
      );
    }
  }
}

/** SHA-256 the code so raw digits never touch the DB. */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Cryptographically-strong random N-digit numeric code (zero-padded). */
function generateNumericCode(digits: number): string {
  const max = 10 ** digits;
  return randomInt(0, max).toString().padStart(digits, '0');
}
