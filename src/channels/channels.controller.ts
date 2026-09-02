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
  Put,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ChannelsService, CredentialsTestResult } from './channels.service';
import { AssignUsersDto } from './dto/assign-users.dto';
import {
  ChannelAssignmentResponse,
  ChannelResponse,
} from './dto/channel-response.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import {
  StartCredentialsOtpResponse,
  VerifyCredentialsOtpDto,
  VerifyCredentialsOtpResponse,
} from './dto/credentials-otp.dto';
import { SetCredentialsDto } from './dto/set-credentials.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ChannelOtpService } from './email/otp.service';

@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly otp: ChannelOtpService,
  ) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser): Promise<ChannelResponse[]> {
    return this.channels.list(actor);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateChannelDto): Promise<ChannelResponse> {
    return this.channels.create(dto);
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ChannelResponse> {
    return this.channels.get(id, actor);
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

  @Get(':id/users')
  @Roles(UserRole.ADMIN)
  listAssignments(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChannelAssignmentResponse[]> {
    return this.channels.listAssignments(id);
  }

  @Post(':id/users')
  @Roles(UserRole.ADMIN)
  assignUsers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignUsersDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ChannelAssignmentResponse[]> {
    return this.channels.assignUsers(id, dto.userIds, actor);
  }

  @Delete(':id/users/:userId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unassignUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.channels.unassignUser(id, userId);
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
   * Legacy SMTP+IMAP handshake test. Kept for the IMAP loop's own
   * startup check and admins who want a quick TCP-level probe, but the
   * user-facing "Test connection" button now uses the OTP flow below.
   */
  @Post(':id/credentials/test')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  testCredentials(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CredentialsTestResult> {
    return this.channels.testCredentials(id);
  }

  /**
   * Send a 6-digit OTP FROM the connected mailbox TO the current admin's
   * Bridge email. Proves outbound SMTP works end-to-end (not just that
   * TCP + login succeed). Follow-up: POST /credentials/test-otp/verify.
   */
  @Post(':id/credentials/test-otp/start')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  startCredentialsOtp(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StartCredentialsOtpResponse> {
    return this.otp.start(id, actor.email);
  }

  @Post(':id/credentials/test-otp/verify')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  verifyCredentialsOtp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyCredentialsOtpDto,
  ): Promise<VerifyCredentialsOtpResponse> {
    return this.otp.verify(id, dto.challengeId, dto.code);
  }
}
