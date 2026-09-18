import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './entities/channel.entity';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { EmailCredentialsService } from './email/email-credentials.service';
import { EmailSenderService } from './email/email-sender.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Channel])],
  controllers: [ChannelsController],
  providers: [ChannelsService, EmailCredentialsService, EmailSenderService],
  // EmailSenderService exported so TicketsService can reach it for
  // outbound replies without pulling in credential internals.
  exports: [ChannelsService, EmailCredentialsService, EmailSenderService],
})
export class ChannelsModule {}
