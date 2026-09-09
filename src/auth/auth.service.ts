import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import ms, { StringValue } from 'ms';
import { generateOpaqueToken, hashToken } from '../common/crypto/tokens';
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

@Injectable()
export class AuthService {
  private readonly accessTtl: StringValue = '15m';
  private readonly refreshTtl: StringValue = '7d';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Issue a fresh access + refresh token pair for a user. Overwrites
   * any previous refresh token on the User row (single-session-per-user
   * semantics — logging in on a new device signs out the old one).
   */
  async issueSession(user: User): Promise<IssuedSession> {
    const accessToken = await this.signAccessToken(user);
    const accessTokenExpiresAt = new Date(Date.now() + ms(this.accessTtl));

    const rawRefresh = generateOpaqueToken();
    const refreshTokenExpiresAt = new Date(Date.now() + ms(this.refreshTtl));

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash: hashToken(rawRefresh),
        refreshTokenExpiresAt,
      },
    });

    return {
      accessToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      user: toSessionUser(user),
      refreshToken: rawRefresh,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Rotate a refresh token: verify the presented token matches the one
   * stored on the User row, then generate a new pair. Invalidates the
   * previous token in the same step.
   */
  async rotateRefresh(rawRefreshToken: string): Promise<IssuedSession> {
    const tokenHash = hashToken(rawRefreshToken);

    const user = await this.prisma.user.findFirst({
      where: { refreshTokenHash: tokenHash },
    });

    if (
      !user ||
      user.refreshTokenExpiresAt === null ||
      user.refreshTokenExpiresAt.getTime() <= Date.now() ||
      user.deactivatedAt !== null
    ) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    return this.issueSession(user);
  }

  /** Clear the refresh token on the user row that owns this raw token. */
  async revokeRefresh(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);
    await this.prisma.user.updateMany({
      where: { refreshTokenHash: tokenHash },
      data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
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
