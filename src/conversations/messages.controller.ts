import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ListMessagesDto } from './dto/list-messages.dto';
import type {
  MessageListResponse,
  MessageResponse,
} from './dto/message-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagesService } from './messages.service';

@Controller('conversations/:conversationId/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListMessagesDto,
  ): Promise<MessageListResponse> {
    return this.messages.list(conversationId, actor, query);
  }

  @Post()
  send(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: SendMessageDto,
  ): Promise<MessageResponse> {
    return this.messages.send(conversationId, actor, dto);
  }
}
