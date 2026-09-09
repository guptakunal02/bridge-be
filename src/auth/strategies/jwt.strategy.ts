import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import type { EnvVars } from '../../config/env.validation';
import { User } from '../../database/entities';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
} from '../types/authenticated-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<EnvVars, true>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        isApproved: true,
        deactivatedAt: true,
      },
    });

    if (!user || user.deactivatedAt !== null) {
      throw new UnauthorizedException('Account is not active');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      isApproved: user.isApproved,
    };
  }
}
