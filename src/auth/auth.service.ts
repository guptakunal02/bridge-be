import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Agent } from '@prisma/client';
import argon2 from 'argon2';
import ms, { StringValue } from 'ms';
import { generateOpaqueToken, hashToken } from '../common/crypto/tokens';
import type { EnvVars } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type {
  SessionAgentResponse,
  SessionResponse,
} from './dto/session-response.dto';
import type { AccessTokenPayload } from './types/authenticated-agent';

export interface IssuedSession extends SessionResponse {
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  private readonly accessTtl: StringValue;
  private readonly refreshTtl: StringValue;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.accessTtl = config.get('JWT_ACCESS_TTL', { infer: true });
    this.refreshTtl = config.get('JWT_REFRESH_TTL', { infer: true });
  }

  async validateCredentials(email: string, password: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!agent || agent.deactivatedAt !== null) {
      // Constant-time-ish: still run a verify to reduce timing side channels
      await argon2
        .verify(
          '$argon2id$v=19$m=65536,t=3,p=4$dummydummydummy$dummydummydummydummydummydummydummydummydummydu',
          password,
        )
        .catch(() => false);
      throw new UnauthorizedException('Invalid email or password');
    }

    const ok = await argon2.verify(agent.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return agent;
  }

  async issueSession(
    agent: Agent,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const accessToken = await this.signAccessToken(agent);
    const accessTokenExpiresAt = new Date(Date.now() + ms(this.accessTtl));

    const rawRefresh = generateOpaqueToken();
    const refreshTokenExpiresAt = new Date(Date.now() + ms(this.refreshTtl));

    await this.prisma.refreshToken.create({
      data: {
        agentId: agent.id,
        tokenHash: hashToken(rawRefresh),
        expiresAt: refreshTokenExpiresAt,
        createdByIp: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    return {
      accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      agent: this.toSessionAgent(agent),
      refreshToken: rawRefresh,
      refreshTokenExpiresAt,
    };
  }

  async rotateRefresh(
    rawRefreshToken: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const tokenHash = hashToken(rawRefreshToken);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { agent: true },
      });

      if (
        !row ||
        row.revokedAt !== null ||
        row.expiresAt.getTime() <= Date.now() ||
        row.agent.deactivatedAt !== null
      ) {
        throw new UnauthorizedException('Refresh token is invalid or expired');
      }

      const rawNew = generateOpaqueToken();
      const newExpiresAt = new Date(Date.now() + ms(this.refreshTtl));
      const newRow = await tx.refreshToken.create({
        data: {
          agentId: row.agentId,
          tokenHash: hashToken(rawNew),
          expiresAt: newExpiresAt,
          createdByIp: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });

      await tx.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), replacedById: newRow.id },
      });

      const accessToken = await this.signAccessToken(row.agent);
      const accessTokenExpiresAt = new Date(Date.now() + ms(this.accessTtl));

      return {
        accessToken,
        accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
        agent: this.toSessionAgent(row.agent),
        refreshToken: rawNew,
        refreshTokenExpiresAt: newExpiresAt,
      };
    });
  }

  async revokeRefresh(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async findSessionAgent(agentId: string): Promise<SessionAgentResponse> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatarUrl: true,
        deactivatedAt: true,
      },
    });
    if (!agent || agent.deactivatedAt !== null) {
      throw new UnauthorizedException('Account is not active');
    }
    return {
      id: agent.id,
      email: agent.email,
      name: agent.name,
      role: agent.role,
      avatarUrl: agent.avatarUrl,
    };
  }

  private toSessionAgent(agent: Agent): SessionAgentResponse {
    return {
      id: agent.id,
      email: agent.email,
      name: agent.name,
      role: agent.role,
      avatarUrl: agent.avatarUrl,
    };
  }

  private signAccessToken(
    agent: Pick<Agent, 'id' | 'email' | 'role'>,
  ): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: agent.id,
      email: agent.email,
      role: agent.role,
    };
    return this.jwt.signAsync(payload, { expiresIn: this.accessTtl });
  }
}
