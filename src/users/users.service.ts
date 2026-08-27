import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserResponse, toUserResponse } from './dto/user-response.dto';
import type { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<UserResponse[]> {
    const users = await this.prisma.user.findMany({
      orderBy: [{ deactivatedAt: 'asc' }, { createdAt: 'asc' }],
    });
    return users.map(toUserResponse);
  }

  async getById(id: string, actor: AuthenticatedUser): Promise<UserResponse> {
    if (actor.role !== UserRole.ADMIN && actor.id !== id) {
      throw new ForbiddenException('You can only view your own profile');
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toUserResponse(user);
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    const isSelf = actor.id === id;
    const isAdmin = actor.role === UserRole.ADMIN;

    if (!isSelf && !isAdmin) {
      throw new ForbiddenException('You can only update your own profile');
    }

    if (dto.role !== undefined && !isAdmin) {
      throw new ForbiddenException('Only admins can change roles');
    }

    if (dto.role !== undefined && isSelf && dto.role !== UserRole.ADMIN) {
      // Prevent an admin demoting themselves — could lock out the only admin.
      const adminCount = await this.prisma.user.count({
        where: { role: UserRole.ADMIN, deactivatedAt: null },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot demote the last active admin');
      }
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.photoUrl !== undefined) data.photoUrl = dto.photoUrl;
    if (dto.role !== undefined) data.role = dto.role;

    if (Object.keys(data).length === 0) {
      const existing = await this.prisma.user.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('User not found');
      return toUserResponse(existing);
    }

    try {
      const updated = await this.prisma.user.update({ where: { id }, data });
      return toUserResponse(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
  }

  async deactivate(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    if (actor.id === id) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');

    if (target.role === UserRole.ADMIN) {
      const activeAdmins = await this.prisma.user.count({
        where: { role: UserRole.ADMIN, deactivatedAt: null },
      });
      if (activeAdmins <= 1) {
        throw new BadRequestException(
          'Cannot deactivate the last active admin',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { deactivatedAt: new Date() },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return toUserResponse(updated);
  }

  async reactivate(id: string): Promise<UserResponse> {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    const updated = await this.prisma.user.update({
      where: { id },
      data: { deactivatedAt: null },
    });
    return toUserResponse(updated);
  }
}
