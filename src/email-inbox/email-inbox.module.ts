import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import { EmailInboxController } from './email-inbox.controller';
import { EmailInboxService } from './email-inbox.service';
import { EmailInboxWorker } from './email-inbox.worker';
import { EmailMessage } from './entities/email-message.entity';
import { EmailMessageRepository } from './providers/email-message.repository';

@Module({
  imports: [
    // Both EmailMessage (owned by this module) and Channel (owned by
    // channels/, but read here by the worker to find IDLE targets).
    // Registering the same entity in multiple modules is fine — they
    // all share the app-wide DataSource.
    TypeOrmModule.forFeature([EmailMessage, Channel]),
    // Gives us EmailCredentialsService for decrypting SMTP/IMAP creds.
    ChannelsModule,
  ],
  controllers: [EmailInboxController],
  providers: [EmailInboxService, EmailMessageRepository, EmailInboxWorker],
  exports: [EmailInboxService, EmailMessageRepository, EmailInboxWorker],
})
export class EmailInboxModule {}
