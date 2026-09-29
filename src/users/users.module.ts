import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { AssignmentPickerService } from './assignment-picker.service';
import { User } from './entities/user.entity';
import { PresenceService } from './presence.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // ChannelsModule exports SystemMailerService — needed by
  // UsersService.invite() to send the invite email through the
  // workspace's own connected inbox.
  imports: [TypeOrmModule.forFeature([User]), ChannelsModule],
  controllers: [UsersController],
  providers: [UsersService, PresenceService, AssignmentPickerService],
  exports: [UsersService, PresenceService, AssignmentPickerService],
})
export class UsersModule {}
