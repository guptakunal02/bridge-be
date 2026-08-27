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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ConversationsService } from './conversations.service';
import type {
  ConversationListResponse,
  ConversationResponse,
} from './dto/conversation-response.dto';
import { ListConversationsDto } from './dto/list-conversations.dto';
import {
  AssignConversationDto,
  UpdateConversationDto,
} from './dto/update-conversation.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListConversationsDto,
  ): Promise<ConversationListResponse> {
    return this.conversations.list(actor, query);
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    return this.conversations.get(id, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    if (dto.status === undefined) {
      // Nothing to change; return current.
      return this.conversations.get(id, actor);
    }
    return this.conversations.updateStatus(id, dto.status, actor);
  }

  @Patch(':id/assignment')
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignConversationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    const target = dto.userId === undefined ? null : dto.userId;
    return this.conversations.assign(id, target, actor);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ConversationResponse> {
    return this.conversations.markRead(id, actor);
  }
}
