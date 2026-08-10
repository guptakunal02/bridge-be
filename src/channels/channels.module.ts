import { Module } from '@nestjs/common';
import { ChannelAdapterRegistry } from './adapters/channel-adapter.registry';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelAdapterRegistry],
  exports: [ChannelsService, ChannelAdapterRegistry],
})
export class ChannelsModule {}
