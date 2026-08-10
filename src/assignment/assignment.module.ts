import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { AssignmentService } from './assignment.service';

@Module({
  imports: [ConversationsModule],
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentModule {}
