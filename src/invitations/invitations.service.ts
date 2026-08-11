import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRole, Invitation } from '@prisma/client';
import argon2 from 'argon2';
import {
  AuthService,
  IssuedSession,
  RequestContext,
} from '../auth/auth.service';
import { SystemMailer } from '../channels/email/system-mailer.service';
import { generateOpaqueToken, hashToken } from '../common/crypto/tokens';
import type { EnvVars } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateInvitationDto } from './dto/create-invitation.dto';
import {
  CreateInvitationResponse,
  InvitationResponse,
  toInvitationResponse,
} from './dto/invitation-response.dto';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly mailer: SystemMailer,
  ) {}

  async create(
    dto: CreateInvitationDto,
    invitedById: string,
  ): Promise<CreateInvitationResponse> {
    const email = dto.email.toLowerCase();

    const existingAgent = await this.prisma.agent.findUnique({
      where: { email },
    });
    if (existingAgent) {
      throw new ConflictException('An agent with this email already exists');
    }

    // Auto-revoke any prior pending invitation for this email so there's only one live token.
    await this.prisma.invitation.updateMany({
      where: { email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Validate channel ids up front so admin gets an immediate error rather
    // than a surprise-empty membership on accept.
    const channelIds = dto.channelIds ?? [];
    if (channelIds.length > 0) {
      const existing = await this.prisma.channel.findMany({
        where: { id: { in: channelIds } },
        select: { id: true },
      });
      if (existing.length !== channelIds.length) {
        throw new BadRequestException(
          'One or more channelIds refer to channels that no longer exist',
        );
      }
    }

    const rawToken = generateOpaqueToken();
    const invitation = await this.prisma.invitation.create({
      data: {
        email,
        role: dto.role ?? AgentRole.AGENT,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById,
        channelIds,
      },
    });

    const acceptUrl = this.buildAcceptUrl(rawToken);

    // Best-effort: send the invitation via the system mailer (first CONNECTED
    // EMAIL channel). Response always includes acceptUrl so admin can copy
    // it manually as a fallback.
    const invitedBy = await this.prisma.agent.findUnique({
      where: { id: invitedById },
      select: { name: true, email: true },
    });
    let emailSent = false;
    if (invitedBy) {
      const result = await this.mailer.sendInvite({
        to: email,
        acceptUrl,
        invitedBy,
      });
      emailSent = result.ok;
    }

    return {
      ...toInvitationResponse(invitation),
      acceptUrl,
      emailSent,
    };
  }

  async list(): Promise<InvitationResponse[]> {
    const rows = await this.prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toInvitationResponse);
  }

  async revoke(id: string): Promise<InvitationResponse> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.acceptedAt) {
      throw new BadRequestException('Invitation was already accepted');
    }
    if (invitation.revokedAt) return toInvitationResponse(invitation);
    const updated = await this.prisma.invitation.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return toInvitationResponse(updated);
  }

  async accept(
    rawToken: string,
    name: string,
    password: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const tokenHash = hashToken(rawToken);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const session = await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.invitation.findUnique({
        where: { tokenHash },
      });
      if (!invitation) throw new NotFoundException('Invitation not found');

      this.assertUsable(invitation);

      const existing = await tx.agent.findUnique({
        where: { email: invitation.email },
      });
      if (existing) {
        throw new ConflictException('An agent with this email already exists');
      }

      const agent = await tx.agent.create({
        data: {
          email: invitation.email,
          name,
          passwordHash,
          role: invitation.role,
        },
      });

      // Grant AgentChannel membership for whichever channels still exist.
      if (invitation.channelIds.length > 0) {
        const stillExisting = await tx.channel.findMany({
          where: { id: { in: invitation.channelIds } },
          select: { id: true },
        });
        if (stillExisting.length > 0) {
          await tx.agentChannel.createMany({
            data: stillExisting.map((c) => ({
              agentId: agent.id,
              channelId: c.id,
              assignedByAgentId: invitation.invitedById,
            })),
            skipDuplicates: true,
          });
        }
      }

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      return agent;
    });

    return this.auth.issueSession(session, ctx);
  }

  private assertUsable(invitation: Invitation): void {
    if (invitation.acceptedAt)
      throw new BadRequestException('Invitation already accepted');
    if (invitation.revokedAt)
      throw new BadRequestException('Invitation was revoked');
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invitation has expired');
    }
  }

  private buildAcceptUrl(rawToken: string): string {
    const origin = this.config.get('FRONTEND_ORIGIN', { infer: true });
    return `${origin.replace(/\/$/, '')}/invitations/${rawToken}`;
  }
}
