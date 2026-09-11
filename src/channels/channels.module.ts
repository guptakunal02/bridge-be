import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './entities/channel.entity';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { EmailCredentialsService } from './email/email-credentials.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Channel])],
  controllers: [ChannelsController],
  providers: [ChannelsService, EmailCredentialsService],
  exports: [ChannelsService, EmailCredentialsService],
})
export class ChannelsModule {}
