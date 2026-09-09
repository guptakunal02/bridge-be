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
import { Roles } from '../auth/decorators/roles.decorator';
import { ChannelsService } from './channels.service';
import { ChannelResponse } from './dto/channel-response.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import { SetCredentialsDto } from './dto/set-credentials.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';

@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

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
}
