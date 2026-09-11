import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { User } from '../users/entities/user.entity';
import type { Request, Response } from 'express';
import type { EnvVars } from '../config/env.validation';
import { AuthService, IssuedSession } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { UnapprovedAllowed } from './decorators/unapproved-allowed.decorator';
import type {
  SessionResponse,
  SessionUserResponse,
} from './dto/session-response.dto';
import { GoogleOAuthCallbackGuard } from './guards/google-oauth-callback.guard';
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie';
import type { AuthenticatedUser } from './types/authenticated-user';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  // Initiates the OAuth 2.0 authorization-code flow. Passport's AuthGuard
  // for the 'google' strategy short-circuits the request into a 302 that
  // sends the browser to accounts.google.com — the handler body never runs.
  @Public()
  @UseGuards(AuthGuard('google'))
  @Get('google')
  googleAuth(): void {
    // Intentionally empty: guard redirects to Google.
  }

  // Google redirects back with ?code=... — Passport exchanges the code
  // server-to-server, resolves the User (auto-creates if new), and we
  // issue a session + set the refresh cookie before redirecting.
  @Public()
  @UseGuards(GoogleOAuthCallbackGuard)
  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const user = req.user as User | undefined;
    const origin = this.config.get('FRONTEND_ORIGIN', { infer: true });
    if (!user) {
      // GoogleOAuthCallbackGuard already redirected — defensive branch.
      return;
    }
    const session = await this.auth.issueSession(user);
    this.applyRefreshCookie(res, session);
    // Approved users land inside the app; unapproved users get parked on
    // /access-restricted where session-context can hit /auth/me + /logout.
    const landing = user.isApproved ? '/inbox' : '/access-restricted';
    res.redirect(`${origin}${landing}`);
  }

  @Public()
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
    const session = await this.auth.rotateRefresh(token);
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

  // Reachable by unapproved users so the frontend can inspect `isApproved`
  // from the /access-restricted screen without being kicked to 403.
  @UnapprovedAllowed()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<SessionUserResponse> {
    return this.auth.findSessionUser(user.id);
  }

  private readRefreshCookie(req: Request): string | null {
    const cookies = (req as unknown as { cookies?: Record<string, string> })
      .cookies;
    const value = cookies?.[REFRESH_COOKIE_NAME];
    return typeof value === 'string' && value.length > 0 ? value : null;
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
      user: session.user,
    };
  }
}
