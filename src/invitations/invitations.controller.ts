import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AgentRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { INVITATION_ACCEPT_THROTTLE } from '../common/throttler/throttler.module';
import type { EnvVars } from '../config/env.validation';
import { CurrentAgent } from '../auth/decorators/current-agent.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { setRefreshCookie } from '../auth/refresh-cookie';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import type { SessionResponse } from '../auth/dto/session-response.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import {
  CreateInvitationResponse,
  InvitationResponse,
} from './dto/invitation-response.dto';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  @Post()
  @Roles(AgentRole.ADMIN)
  create(
    @Body() dto: CreateInvitationDto,
    @CurrentAgent() actor: AuthenticatedAgent,
  ): Promise<CreateInvitationResponse> {
    return this.invitations.create(dto, actor.id);
  }

  @Get()
  @Roles(AgentRole.ADMIN)
  list(): Promise<InvitationResponse[]> {
    return this.invitations.list();
  }

  @Post(':id/revoke')
  @Roles(AgentRole.ADMIN)
  revoke(@Param('id', ParseUUIDPipe) id: string): Promise<InvitationResponse> {
    return this.invitations.revoke(id);
  }

  @Public()
  @Throttle(INVITATION_ACCEPT_THROTTLE)
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string'
        ? forwarded.split(',')[0]?.trim()
        : undefined) ??
      req.ip ??
      null;
    const uaHeader = req.headers['user-agent'];
    const userAgent = typeof uaHeader === 'string' ? uaHeader : null;

    const session = await this.invitations.accept(
      token,
      dto.name,
      dto.password,
      {
        ip,
        userAgent,
      },
    );

    setRefreshCookie(
      res,
      this.config.get('NODE_ENV', { infer: true }),
      session.refreshToken,
      session.refreshTokenExpiresAt,
    );

    return {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      agent: session.agent,
    };
  }
}
