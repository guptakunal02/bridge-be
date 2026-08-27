import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import ms, { StringValue } from 'ms';
import { generateOpaqueToken, hashToken } from '../common/crypto/tokens';
import type { EnvVars } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type {
  SessionResponse,
  SessionUserResponse,
} from './dto/session-response.dto';
import type { AccessTokenPayload } from './types/authenticated-user';

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

  async issueSession(
    user: User,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const accessToken = await this.signAccessToken(user);
    const accessTokenExpiresAt = new Date(Date.now() + ms(this.accessTtl));

    const rawRefresh = generateOpaqueToken();
    const refreshTokenExpiresAt = new Date(Date.now() + ms(this.refreshTtl));

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawRefresh),
        expiresAt: refreshTokenExpiresAt,
        createdByIp: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    return {
      accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      user: this.toSessionUser(user),
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
        include: { user: true },
      });

      if (
        !row ||
        row.revokedAt !== null ||
        row.expiresAt.getTime() <= Date.now() ||
        row.user.deactivatedAt !== null
      ) {
        throw new UnauthorizedException('Refresh token is invalid or expired');
      }

      const rawNew = generateOpaqueToken();
      const newExpiresAt = new Date(Date.now() + ms(this.refreshTtl));
      const newRow = await tx.refreshToken.create({
        data: {
          userId: row.userId,
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

      const accessToken = await this.signAccessToken(row.user);
      const accessTokenExpiresAt = new Date(Date.now() + ms(this.accessTtl));

      return {
        accessToken,
        accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
        user: this.toSessionUser(row.user),
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

  async findSessionUser(userId: string): Promise<SessionUserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        photoUrl: true,
        role: true,
        isApproved: true,
        deactivatedAt: true,
      },
    });
    if (!user || user.deactivatedAt !== null) {
      throw new UnauthorizedException('Account is not active');
    }
    return toSessionUser(user);
  }

  private toSessionUser(user: User): SessionUserResponse {
    return toSessionUser(user);
  }

  private signAccessToken(
    user: Pick<User, 'id' | 'email' | 'role' | 'isApproved'>,
  ): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      isApproved: user.isApproved,
    };
    return this.jwt.signAsync(payload, { expiresIn: this.accessTtl });
  }
}

function toSessionUser(
  user: Pick<
    User,
    'id' | 'email' | 'name' | 'phone' | 'photoUrl' | 'role' | 'isApproved'
  >,
): SessionUserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    photoUrl: user.photoUrl,
    role: user.role,
    isApproved: user.isApproved,
  };
}
