import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AgentRole, Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedAgent } from '../auth/types/authenticated-agent';
import type { ChangePasswordDto } from './dto/change-password.dto';
import { AgentResponse, toAgentResponse } from './dto/agent-response.dto';
import type { UpdateAgentDto } from './dto/update-agent.dto';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AgentResponse[]> {
    const agents = await this.prisma.agent.findMany({
      orderBy: [{ deactivatedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return agents.map(toAgentResponse);
  }

  async getById(id: string, actor: AuthenticatedAgent): Promise<AgentResponse> {
    if (actor.role !== AgentRole.ADMIN && actor.id !== id) {
      throw new ForbiddenException('You can only view your own profile');
    }
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    return toAgentResponse(agent);
  }

  async update(
    id: string,
    dto: UpdateAgentDto,
    actor: AuthenticatedAgent,
  ): Promise<AgentResponse> {
    const isSelf = actor.id === id;
    const isAdmin = actor.role === AgentRole.ADMIN;

    if (!isSelf && !isAdmin) {
      throw new ForbiddenException('You can only update your own profile');
    }

    if (dto.role !== undefined && !isAdmin) {
      throw new ForbiddenException('Only admins can change roles');
    }

    if (dto.role !== undefined && isSelf && dto.role !== AgentRole.ADMIN) {
      // Prevent an admin demoting themselves — could lock out the only admin.
      const adminCount = await this.prisma.agent.count({
        where: { role: AgentRole.ADMIN, deactivatedAt: null },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot demote the last active admin');
      }
    }

    const data: Prisma.AgentUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;
    if (dto.role !== undefined) data.role = dto.role;

    if (Object.keys(data).length === 0) {
      const existing = await this.prisma.agent.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Agent not found');
      return toAgentResponse(existing);
    }

    try {
      const updated = await this.prisma.agent.update({ where: { id }, data });
      return toAgentResponse(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Agent not found');
      }
      throw err;
    }
  }

  async deactivate(
    id: string,
    actor: AuthenticatedAgent,
  ): Promise<AgentResponse> {
    if (actor.id === id) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const target = await this.prisma.agent.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Agent not found');

    if (target.role === AgentRole.ADMIN) {
      const activeAdmins = await this.prisma.agent.count({
        where: { role: AgentRole.ADMIN, deactivatedAt: null },
      });
      if (activeAdmins <= 1) {
        throw new BadRequestException(
          'Cannot deactivate the last active admin',
        );
      }
    }

    const updated = await this.prisma.agent.update({
      where: { id },
      data: { deactivatedAt: new Date() },
    });
    await this.prisma.refreshToken.updateMany({
      where: { agentId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return toAgentResponse(updated);
  }

  async reactivate(id: string): Promise<AgentResponse> {
    const target = await this.prisma.agent.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Agent not found');
    const updated = await this.prisma.agent.update({
      where: { id },
      data: { deactivatedAt: null },
    });
    return toAgentResponse(updated);
  }

  async changeMyPassword(
    agentId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent || agent.deactivatedAt !== null) {
      throw new UnauthorizedException('Account is not active');
    }
    const ok = await argon2.verify(agent.passwordHash, dto.currentPassword);
    if (!ok) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const newHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
    });
    await this.prisma.$transaction([
      this.prisma.agent.update({
        where: { id: agentId },
        data: { passwordHash: newHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { agentId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }
}
