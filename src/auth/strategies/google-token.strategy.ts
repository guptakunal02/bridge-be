import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Agent } from '@prisma/client';
import type { Request } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { Strategy } from 'passport-custom';
import type { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';

interface GoogleTokenBody {
  idToken?: unknown;
}

// Verifies a Google Identity Services (GIS) ID token posted by the SPA and
// resolves it to a real Agent. Invite-only: unknown emails 403, not auto-create.
@Injectable()
export class GoogleTokenStrategy extends PassportStrategy(Strategy, 'google-token') {
  private readonly client: OAuth2Client;
  private readonly audience: string;

  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly prisma: PrismaService,
  ) {
    super();
    this.audience = config.get('GOOGLE_WEB_CLIENT_ID', { infer: true });
    this.client = new OAuth2Client(this.audience);
  }

  async validate(req: Request): Promise<Agent> {
    const body = (req.body ?? {}) as GoogleTokenBody;
    const idToken = typeof body.idToken === 'string' ? body.idToken : null;
    if (!idToken) {
      throw new UnauthorizedException('Missing Google id token');
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audience,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid or expired Google id token');
    }

    if (!payload?.email || payload.email_verified !== true) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    const email = payload.email.toLowerCase();
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (!agent || agent.deactivatedAt !== null) {
      // Token is valid but the identity isn't authorized to use Bridge.
      // Frontend routes 403s to /access-restricted.
      throw new ForbiddenException('This Google account is not authorized');
    }

    return agent;
  }
}
