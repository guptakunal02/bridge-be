import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../common/storage/storage.module';
import { Channel } from './entities/channel.entity';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { EmailCredentialsService } from './email/email-credentials.service';
import { EmailSenderService } from './email/email-sender.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Channel]),
    // S3StorageService — EmailSenderService downloads attachment
    // bytes server-side rather than handing nodemailer a URL, so
    // the FE never influences what the SMTP relay fetches.
    StorageModule,
  ],
  controllers: [ChannelsController],
  providers: [ChannelsService, EmailCredentialsService, EmailSenderService],
  // EmailSenderService exported so TicketsService can reach it for
  // outbound replies without pulling in credential internals.
  exports: [ChannelsService, EmailCredentialsService, EmailSenderService],
})
export class ChannelsModule {}
