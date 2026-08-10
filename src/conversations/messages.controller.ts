import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentAgent } from '../auth/decorators/current-agent.decorator';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
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
    @CurrentAgent() actor: AuthenticatedAgent,
    @Query() query: ListMessagesDto,
  ): Promise<MessageListResponse> {
    return this.messages.list(conversationId, actor, query);
  }

  @Post()
  send(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @CurrentAgent() actor: AuthenticatedAgent,
    @Body() dto: SendMessageDto,
  ): Promise<MessageResponse> {
    return this.messages.send(conversationId, actor, dto);
  }
}
