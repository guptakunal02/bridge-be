import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Get,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Agent } from '@prisma/client';
import type { Request, Response } from 'express';
import {
  AUTH_LOGIN_THROTTLE,
  AUTH_REFRESH_THROTTLE,
} from '../common/throttler/throttler.module';
import type { EnvVars } from '../config/env.validation';
import { AuthService, IssuedSession } from './auth.service';
import { CurrentAgent } from './decorators/current-agent.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import type {
  SessionAgentResponse,
  SessionResponse,
} from './dto/session-response.dto';
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie';
import type { AuthenticatedAgent } from './types/authenticated-agent';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  @Public()
  @Throttle(AUTH_LOGIN_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const agent = await this.auth.validateCredentials(dto.email, dto.password);
    const session = await this.auth.issueSession(agent, this.readContext(req));
    this.applyRefreshCookie(res, session);
    return this.toSessionResponse(session);
  }

  @Public()
  @Throttle(AUTH_LOGIN_THROTTLE)
  @UseGuards(AuthGuard('google-token'))
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async google(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    // GoogleTokenStrategy.validate() populated req.user with the Agent row
    // (or already threw 401/403). From here it's identical to password login.
    const agent = req.user as Agent;
    const session = await this.auth.issueSession(agent, this.readContext(req));
    this.applyRefreshCookie(res, session);
    return this.toSessionResponse(session);
  }

  @Public()
  @Throttle(AUTH_REFRESH_THROTTLE)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const token = this.readRefreshCookie(req);
    if (!token) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const session = await this.auth.rotateRefresh(token, this.readContext(req));
    this.applyRefreshCookie(res, session);
    return this.toSessionResponse(session);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = this.readRefreshCookie(req);
    if (token) {
      await this.auth.revokeRefresh(token);
    }
    clearRefreshCookie(res, this.config.get('NODE_ENV', { infer: true }));
  }

  @Get('me')
  me(@CurrentAgent() agent: AuthenticatedAgent): Promise<SessionAgentResponse> {
    return this.auth.findSessionAgent(agent.id);
  }

  private readRefreshCookie(req: Request): string | null {
    const cookies = (req as unknown as { cookies?: Record<string, string> })
      .cookies;
    const value = cookies?.[REFRESH_COOKIE_NAME];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private readContext(req: Request): {
    ip: string | null;
    userAgent: string | null;
  } {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string'
        ? forwarded.split(',')[0]?.trim()
        : undefined) ??
      req.ip ??
      null;
    const uaHeader = req.headers['user-agent'];
    const userAgent = typeof uaHeader === 'string' ? uaHeader : null;
    return { ip, userAgent };
  }

  private applyRefreshCookie(res: Response, session: IssuedSession): void {
    setRefreshCookie(
      res,
      this.config.get('NODE_ENV', { infer: true }),
      session.refreshToken,
      session.refreshTokenExpiresAt,
    );
  }

  private toSessionResponse(session: IssuedSession): SessionResponse {
    return {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      agent: session.agent,
    };
  }
}
