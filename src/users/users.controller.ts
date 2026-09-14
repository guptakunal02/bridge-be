import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '../database/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { SetStatusDto } from './dto/set-status.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponse, toUserResponse } from './dto/user-response.dto';
import { PresenceService } from './presence.service';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly presence: PresenceService,
  ) {}

  /**
   * Change the caller's own availability status. Endpoint is kept
   * separate from PATCH /users/:id so guards + audit are unambiguous:
   * this route always acts on the caller, never someone else.
   */
  @Patch('me/status')
  async setMyStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: SetStatusDto,
  ): Promise<UserResponse> {
    const updated = await this.presence.setStatus(actor.id, dto.status);
    return toUserResponse(updated);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  list(): Promise<UserResponse[]> {
    return this.users.list();
  }

  @Get(':id')
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.users.getById(id, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.users.update(id, dto, actor);
  }

  @Post(':id/deactivate')
  @Roles(UserRole.ADMIN)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.users.deactivate(id, actor);
  }

  @Post(':id/reactivate')
  @Roles(UserRole.ADMIN)
  reactivate(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponse> {
    return this.users.reactivate(id);
  }
}
