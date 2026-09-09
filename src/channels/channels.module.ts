import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { EmailCredentialsService } from './email/email-credentials.service';

@Module({
  imports: [ConfigModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, EmailCredentialsService],
  exports: [ChannelsService, EmailCredentialsService],
})
export class ChannelsModule {}
