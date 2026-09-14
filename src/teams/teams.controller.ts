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
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../database/enums';
import { CreateTeamDto } from './dto/create-team.dto';
import { AddMemberDto, SetMemberPauseDto } from './dto/team-member.dto';
import { TeamDetail, TeamResponse } from './dto/team-response.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TeamsService } from './teams.service';

/**
 * All team admin routes are ADMIN-only — they mutate routing shape,
 * which affects everyone. Non-admins never need to see them.
 */
@Controller('teams')
@Roles(UserRole.ADMIN)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list(): Promise<TeamResponse[]> {
    return this.teams.list();
  }

  @Post()
  create(@Body() dto: CreateTeamDto): Promise<TeamResponse> {
    return this.teams.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TeamDetail> {
    return this.teams.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
  ): Promise<TeamResponse> {
    return this.teams.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.teams.remove(id);
  }

  @Post(':id/members')
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
  ): Promise<TeamDetail> {
    return this.teams.addMember(id, dto);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<TeamDetail> {
    return this.teams.removeMember(id, userId);
  }

  @Patch(':id/members/:userId')
  setMemberPause(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetMemberPauseDto,
  ): Promise<TeamDetail> {
    return this.teams.setMemberPause(id, userId, dto);
  }
}
