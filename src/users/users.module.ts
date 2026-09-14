import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssignmentPickerService } from './assignment-picker.service';
import { User } from './entities/user.entity';
import { PresenceService } from './presence.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService, PresenceService, AssignmentPickerService],
  exports: [UsersService, PresenceService, AssignmentPickerService],
})
export class UsersModule {}
