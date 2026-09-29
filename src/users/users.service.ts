import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { SystemMailerService } from '../channels/email/system-mailer.service';
import { User } from './entities/user.entity';
import { UserRole } from '../database/enums';
import type { InviteUserDto } from './dto/invite-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import {
  InviteUserResponse,
  UserResponse,
  toUserResponse,
} from './dto/user-response.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly mailer: SystemMailerService,
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

  /**
   * Admin adds an email to the workspace allowlist. Creates a
   * User row with `googleSub = null` and `isApproved = true` — a
   * placeholder that the Google OAuth strategy backfills with the
   * real Google identity on the invitee's first sign-in.
   *
   * After the row is persisted, we fire off an invite email via
   * the workspace's own connected inbox (SystemMailer). Delivery is
   * best-effort: the row is the source of truth, and the
   * `emailSent` flag on the response tells the FE whether to show
   * "email sent" vs a "share the link" fallback.
   *
   * Race note: two admins inviting the same email at the same time
   * will collide on the unique email index and Postgres returns 23505.
   * We surface it as a 409 so the FE can display "already invited"
   * rather than a generic 500.
   */
  async invite(
    dto: InviteUserDto,
    actor: AuthenticatedUser,
  ): Promise<InviteUserResponse> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      if (existing.deactivatedAt !== null) {
        throw new ConflictException(
          `${email} is a deactivated user — reactivate instead of re-inviting.`,
        );
      }
      throw new ConflictException(
        existing.googleSub === null
          ? `${email} has already been invited but hasn't signed in yet.`
          : `${email} is already a member.`,
      );
    }
    // Provisional name = email local-part; overwritten on first sign-in
    // by the Google-provided displayName. Avoids showing an empty name
    // in the Team list while the invite is pending.
    const provisionalName = email.split('@')[0] ?? email;
    const row = this.users.create({
      email,
      name: provisionalName,
      role: dto.role,
      isApproved: true,
      googleSub: null,
    });
    let saved: User;
    try {
      saved = await this.users.save(row);
    } catch (err) {
      // Concurrent-invite race — surface as 409 instead of a generic 500.
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
      ) {
        throw new ConflictException(`${email} has already been invited.`);
      }
      throw err;
    }

    const inviter = await this.users.findOne({ where: { id: actor.id } });
    const emailSent = await this.mailer.sendInvite({
      to: email,
      inviteeName: provisionalName,
      inviterName: inviter?.name ?? 'Your admin',
      role: dto.role,
    });

    return { ...toUserResponse(saved), emailSent };
  }
}
