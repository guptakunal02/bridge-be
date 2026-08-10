import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AgentRole } from '@prisma/client';
import { CurrentAgent } from '../auth/decorators/current-agent.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import { PresenceService } from '../presence/presence.service';
import { AgentsService } from './agents.service';
import { AgentResponse } from './dto/agent-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SetPresenceDto } from './dto/set-presence.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly presence: PresenceService,
  ) {}

  @Get()
  @Roles(AgentRole.ADMIN)
  list(): Promise<AgentResponse[]> {
    return this.agents.list();
  }

  @Patch('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changeMyPassword(
    @CurrentAgent() actor: AuthenticatedAgent,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.agents.changeMyPassword(actor.id, dto);
  }

  @Post('me/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setMyPresence(
    @CurrentAgent() actor: AuthenticatedAgent,
    @Body() dto: SetPresenceDto,
  ): Promise<void> {
    await this.presence.setStatus(actor.id, dto.status);
  }

  @Get(':id')
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAgent() actor: AuthenticatedAgent,
  ): Promise<AgentResponse> {
    return this.agents.getById(id, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentDto,
    @CurrentAgent() actor: AuthenticatedAgent,
  ): Promise<AgentResponse> {
    return this.agents.update(id, dto, actor);
  }

  @Post(':id/deactivate')
  @Roles(AgentRole.ADMIN)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAgent() actor: AuthenticatedAgent,
  ): Promise<AgentResponse> {
    return this.agents.deactivate(id, actor);
  }

  @Post(':id/reactivate')
  @Roles(AgentRole.ADMIN)
  reactivate(@Param('id', ParseUUIDPipe) id: string): Promise<AgentResponse> {
    return this.agents.reactivate(id);
  }
}
