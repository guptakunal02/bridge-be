import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { Public } from '../auth/decorators/public.decorator';
import { UserRole } from '../database/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import type { EnvVars } from '../config/env.validation';
import { ChannelsService } from './channels.service';
import { ChannelResponse } from './dto/channel-response.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import { SetCredentialsDto } from './dto/set-credentials.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { GoogleOAuthService } from './email/google-oauth.service';
import {
  decodeOAuthState,
  encodeOAuthState,
} from './email/oauth-state';

@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  @Get()
  list(): Promise<ChannelResponse[]> {
    return this.channels.list();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateChannelDto): Promise<ChannelResponse> {
    return this.channels.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ChannelResponse> {
    return this.channels.get(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChannelDto,
  ): Promise<ChannelResponse> {
    return this.channels.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.channels.remove(id);
  }

  @Put(':id/credentials')
  @Roles(UserRole.ADMIN)
  setCredentials(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCredentialsDto,
  ): Promise<ChannelResponse> {
    return this.channels.setCredentials(id, dto);
  }

  /**
   * Kick off the Google OAuth consent flow for this channel.
   * Returns the Google authorize URL — the FE navigates the browser
   * there. Signed state carries the channel + user id through the
   * redirect so the callback can identify what to save without
   * relying on cookies/session across the third-party bounce.
   */
  @Get(':id/email/oauth/authorize')
  @Roles(UserRole.ADMIN)
  authorizeEmailOAuth(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): { authorizeUrl: string } {
    const state = encodeOAuthState(
      { channelId: id, userId: user.id },
      this.config.get('JWT_ACCESS_SECRET', { infer: true }),
    );
    const url = this.googleOAuth.buildAuthorizeUrl(state);
    return { authorizeUrl: url };
  }

  /**
   * Google redirects here after consent with `?code=...&state=...`.
   * Public because Google won't carry our auth cookies over —
   * defence is in the state HMAC. On success we save the tokens
   * and bounce the browser back to the FE with a success flag.
   */
  @Public()
  @Get('email/oauth/callback')
  async oauthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const frontendOrigin = this.config.get('FRONTEND_ORIGIN', { infer: true });
    if (error) {
      return this.redirectToFe(res, frontendOrigin, {
        error: `google:${error}`,
      });
    }
    if (!code || !state) {
      throw new BadRequestException('Missing OAuth code or state.');
    }
    let payload;
    try {
      payload = decodeOAuthState(
        state,
        this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      );
    } catch (verifyErr) {
      const msg =
        verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      return this.redirectToFe(res, frontendOrigin, {
        error: `state:${msg}`,
      });
    }
    try {
      const tokens = await this.googleOAuth.exchangeCode(code);
      await this.channels.saveEmailOAuthCredentials(payload.channelId, {
        address: tokens.address,
        refreshToken: tokens.refreshToken,
      });
      return this.redirectToFe(res, frontendOrigin, {
        channelId: payload.channelId,
        connected: '1',
      });
    } catch (persistErr) {
      const msg =
        persistErr instanceof Error ? persistErr.message : String(persistErr);
      return this.redirectToFe(res, frontendOrigin, {
        channelId: payload.channelId,
        error: `exchange:${msg}`,
      });
    }
  }

  private redirectToFe(
    res: Response,
    origin: string,
    params: Record<string, string>,
  ): void {
    const url = new URL('/inboxes', origin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res.redirect(url.toString());
  }
}
