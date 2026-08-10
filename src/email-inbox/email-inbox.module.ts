import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { EmailInboxManager } from './email-inbox.manager';

@Module({
  imports: [ChannelsModule, ConversationsModule],
  providers: [EmailInboxManager],
})
export class EmailInboxModule {}
