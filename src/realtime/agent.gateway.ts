import { Logger, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AgentRole, AgentStatus } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/types/authenticated-agent';
import type { EnvVars } from '../config/env.validation';
import { ConversationsService } from '../conversations/conversations.service';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import type {
  ConversationUpdatedEvent,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  PresenceUpdatedEvent,
} from './events';
import { REALTIME_EVENTS } from './events';
import { WsExceptionsFilter } from './ws-exceptions.filter';

interface AuthedSocket extends Socket {
  data: { agentId: string; role: AgentRole };
}

const AGENT_ROOM = (id: string): string => `agent:${id}`;
const CONVERSATION_ROOM = (id: string): string => `conversation:${id}`;

@UseFilters(WsExceptionsFilter)
@WebSocketGateway({
  namespace: '/ws',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly conversations: ConversationsService,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = this.extractToken(socket);
      if (!token) throw new Error('Missing auth token');

      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });

      const agent = await this.prisma.agent.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, deactivatedAt: true },
      });
      if (!agent || agent.deactivatedAt !== null) {
        throw new Error('Account is not active');
      }

      socket.data = { agentId: agent.id, role: agent.role };
      await socket.join(AGENT_ROOM(agent.id));
      await this.presence.onSocketConnect(agent.id, socket.id);
      this.logger.debug(
        { agentId: agent.id, socketId: socket.id },
        'ws connected',
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unauthorized';
      this.logger.debug({ err, socketId: socket.id }, 'ws auth failed');
      socket.emit('error', { message: reason });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    const agentId = (socket.data as { agentId?: string } | undefined)?.agentId;
    if (!agentId) return;
    this.presence.onSocketDisconnect(agentId, socket.id);
    this.logger.debug({ agentId, socketId: socket.id }, 'ws disconnected');
  }

  @SubscribeMessage('conversation.subscribe')
  async subscribeToConversation(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const conversationId = this.readString(body.conversationId);
    if (!conversationId) return { ok: false, error: 'conversationId required' };

    try {
      await this.conversations.loadWithAccess(conversationId, {
        id: socket.data.agentId,
        email: '',
        role: socket.data.role,
      });
      await socket.join(CONVERSATION_ROOM(conversationId));
      return { ok: true };
    } catch {
      return { ok: false, error: 'not accessible' };
    }
  }

  @SubscribeMessage('conversation.unsubscribe')
  async unsubscribeFromConversation(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<{ ok: true }> {
    const conversationId = this.readString(body.conversationId);
    if (conversationId) {
      await socket.leave(CONVERSATION_ROOM(conversationId));
    }
    return { ok: true };
  }

  @SubscribeMessage('presence.set')
  async setPresence(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() body: { status?: unknown },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const status = this.readStatus(body.status);
    if (!status) return { ok: false, error: 'invalid status' };
    await this.presence.setStatus(socket.data.agentId, status);
    return { ok: true };
  }

  // ---- domain event → socket broadcasts ---------------------------------

  @OnEvent(REALTIME_EVENTS.MessageCreated)
  onMessageCreated(payload: MessageCreatedEvent): void {
    this.server
      .to(CONVERSATION_ROOM(payload.conversationId))
      .emit('message.created', payload);
  }

  @OnEvent(REALTIME_EVENTS.MessageUpdated)
  onMessageUpdated(payload: MessageUpdatedEvent): void {
    this.server
      .to(CONVERSATION_ROOM(payload.conversationId))
      .emit('message.updated', payload);
  }

  @OnEvent(REALTIME_EVENTS.ConversationUpdated)
  onConversationUpdated(payload: ConversationUpdatedEvent): void {
    // Emit to the conversation room and, if assigned, to the assignee's
    // private room. Socket.IO deduplicates delivery when a socket is in
    // both rooms.
    const rooms = [CONVERSATION_ROOM(payload.conversation.id)];
    if (payload.conversation.assignedAgent) {
      rooms.push(AGENT_ROOM(payload.conversation.assignedAgent.id));
    }
    this.server.to(rooms).emit('conversation.updated', payload);
  }

  @OnEvent(REALTIME_EVENTS.PresenceUpdated)
  onPresenceUpdated(payload: PresenceUpdatedEvent): void {
    // Fan out to the affected agent so their own header updates and to a
    // shared 'presence' channel that admins can subscribe to later.
    this.server
      .to(AGENT_ROOM(payload.agentId))
      .emit('presence.updated', payload);
  }

  // ---- helpers ---------------------------------------------------------

  private extractToken(socket: Socket): string | null {
    const auth =
      (socket.handshake.auth as Record<string, unknown> | undefined) ?? {};
    const fromAuth = auth.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

    const authHeader = socket.handshake.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice('Bearer '.length);
    }
    return null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    return value;
  }

  private readStatus(value: unknown): AgentStatus | null {
    if (
      value === AgentStatus.ONLINE ||
      value === AgentStatus.AWAY ||
      value === AgentStatus.OFFLINE
    ) {
      return value;
    }
    return null;
  }
}
