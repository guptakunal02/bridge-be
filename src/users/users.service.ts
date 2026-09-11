import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { User } from './entities/user.entity';
import { UserRole } from '../database/enums';
import type { UpdateUserDto } from './dto/update-user.dto';
import { UserResponse, toUserResponse } from './dto/user-response.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async list(): Promise<UserResponse[]> {
    const users = await this.users.find({
      order: { deactivatedAt: 'ASC', createdAt: 'ASC' },
    });
    return users.map(toUserResponse);
  }

  async getById(id: string, actor: AuthenticatedUser): Promise<UserResponse> {
    if (actor.role !== UserRole.ADMIN && actor.id !== id) {
      throw new ForbiddenException('You can only view your own profile');
    }
    const user = await this.users.findOne({ where: { id } });
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
      const adminCount = await this.users.count({
        where: { role: UserRole.ADMIN, deactivatedAt: IsNull() },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot demote the last active admin');
      }
    }

    const data: Partial<User> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.photoUrl !== undefined) data.photoUrl = dto.photoUrl;
    if (dto.role !== undefined) data.role = dto.role;

    const existing = await this.users.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('User not found');

    if (Object.keys(data).length === 0) {
      return toUserResponse(existing);
    }

    await this.users.update({ id }, data);
    const updated = await this.users.findOneOrFail({ where: { id } });
    return toUserResponse(updated);
  }

  async deactivate(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    if (actor.id === id) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const target = await this.users.findOne({ where: { id } });
    if (!target) throw new NotFoundException('User not found');

    if (target.role === UserRole.ADMIN) {
      const activeAdmins = await this.users.count({
        where: { role: UserRole.ADMIN, deactivatedAt: IsNull() },
      });
      if (activeAdmins <= 1) {
        throw new BadRequestException(
          'Cannot deactivate the last active admin',
        );
      }
    }

    await this.users.update({ id }, { deactivatedAt: new Date() });
    const updated = await this.users.findOneOrFail({ where: { id } });
    return toUserResponse(updated);
  }

  async reactivate(id: string): Promise<UserResponse> {
    const target = await this.users.findOne({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    await this.users.update({ id }, { deactivatedAt: null });
    const updated = await this.users.findOneOrFail({ where: { id } });
    return toUserResponse(updated);
  }
}
