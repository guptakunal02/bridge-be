import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../common/storage/storage.module';
import { Channel } from './entities/channel.entity';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { AccessTokenCache } from './email/access-token-cache';
import { EmailCredentialsService } from './email/email-credentials.service';
import { EmailSenderService } from './email/email-sender.service';
import { GoogleOAuthService } from './email/google-oauth.service';

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
  providers: [
    ChannelsService,
    EmailCredentialsService,
    EmailSenderService,
    GoogleOAuthService,
    AccessTokenCache,
  ],
  // EmailSenderService exported so TicketsService can reach it for
  // outbound replies without pulling in credential internals. The
  // OAuth pieces are exported so the email-inbox IMAP worker can
  // reach them for XOAUTH2 auth on IMAP.
  exports: [
    ChannelsService,
    EmailCredentialsService,
    EmailSenderService,
    GoogleOAuthService,
    AccessTokenCache,
  ],
})
export class ChannelsModule {}
