import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { InstagramStubController } from './instagram-stub.controller';

@Module({
  imports: [ChannelsModule, ConversationsModule],
  controllers: [InstagramStubController],
})
export class WebhooksModule {}
