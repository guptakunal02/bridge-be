import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation';
import { NodeEnv } from '../config/env.validation';
import {
  CHANNEL_ADAPTERS,
  ChannelAdapterRegistry,
} from './adapters/channel-adapter.registry';
import type { ChannelAdapter } from './adapters/channel-adapter.port';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { EmailAdapter } from './email/email.adapter';
import { EmailCredentialsService } from './email/email-credentials.service';
import { InstagramStubAdapter } from './instagram/instagram-stub.adapter';

@Module({
  imports: [ConfigModule],
  controllers: [ChannelsController],
  providers: [
    ChannelsService,
    InstagramStubAdapter,
    EmailAdapter,
    EmailCredentialsService,
    {
      provide: CHANNEL_ADAPTERS,
      // In dev/test, register the Instagram stub so agent send + Phase-6 stub
      // webhook work end-to-end. In prod, register nothing here — the real
      // Meta adapter (Phase 7) will slot into this same array.
      // Email adapter is real for all environments (no stub needed; SMTP is SMTP).
      useFactory: (
        config: ConfigService<EnvVars, true>,
        stub: InstagramStubAdapter,
        email: EmailAdapter,
      ): ChannelAdapter[] => {
        const nodeEnv = config.get('NODE_ENV', { infer: true });
        const adapters: ChannelAdapter[] = [email];
        if (nodeEnv !== NodeEnv.Production) adapters.push(stub);
        return adapters;
      },
      inject: [ConfigService, InstagramStubAdapter, EmailAdapter],
    },
    ChannelAdapterRegistry,
  ],
  exports: [ChannelsService, ChannelAdapterRegistry, EmailCredentialsService],
})
export class ChannelsModule {}
