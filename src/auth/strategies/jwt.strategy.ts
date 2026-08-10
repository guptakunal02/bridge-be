import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { EnvVars } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AccessTokenPayload,
  AuthenticatedAgent,
} from '../types/authenticated-agent';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedAgent> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, deactivatedAt: true },
    });

    if (!agent || agent.deactivatedAt !== null) {
      throw new UnauthorizedException('Account is not active');
    }

    return { id: agent.id, email: agent.email, role: agent.role };
  }
}
