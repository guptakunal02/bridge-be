import {
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
} from '@nestjs/common';
import { AgentRole } from '@prisma/client';
import { CurrentAgent } from '../auth/decorators/current-agent.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import { ChannelsService } from './channels.service';
import { AssignAgentsDto } from './dto/assign-agents.dto';
import {
  ChannelAssignmentResponse,
  ChannelResponse,
} from './dto/channel-response.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';

@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(@CurrentAgent() actor: AuthenticatedAgent): Promise<ChannelResponse[]> {
    return this.channels.list(actor);
  }

  @Post()
  @Roles(AgentRole.ADMIN)
  create(@Body() dto: CreateChannelDto): Promise<ChannelResponse> {
    return this.channels.create(dto);
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAgent() actor: AuthenticatedAgent,
  ): Promise<ChannelResponse> {
    return this.channels.get(id, actor);
  }

  @Patch(':id')
  @Roles(AgentRole.ADMIN)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChannelDto,
  ): Promise<ChannelResponse> {
    return this.channels.update(id, dto);
  }

  @Delete(':id')
  @Roles(AgentRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.channels.remove(id);
  }

  @Get(':id/agents')
  @Roles(AgentRole.ADMIN)
  listAssignments(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChannelAssignmentResponse[]> {
    return this.channels.listAssignments(id);
  }

  @Post(':id/agents')
  @Roles(AgentRole.ADMIN)
  assignAgents(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignAgentsDto,
    @CurrentAgent() actor: AuthenticatedAgent,
  ): Promise<ChannelAssignmentResponse[]> {
    return this.channels.assignAgents(id, dto.agentIds, actor);
  }

  @Delete(':id/agents/:agentId')
  @Roles(AgentRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unassignAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ): Promise<void> {
    await this.channels.unassignAgent(id, agentId);
  }
}
