import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { AgentGateway } from './agent.gateway';
import { WsExceptionsFilter } from './ws-exceptions.filter';

@Module({
  // AuthModule exports JwtService via its JwtModule registration; we reuse
  // the same access-token secret for socket handshake verification.
  imports: [AuthModule, forwardRef(() => ConversationsModule)],
  providers: [AgentGateway, WsExceptionsFilter],
})
export class RealtimeModule {}
