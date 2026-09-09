import { User } from '../../database/entities';
import { UserRole, UserStatus } from '../../database/enums';

export interface UserResponse {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  status: UserStatus;
  photoUrl: string | null;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    photoUrl: user.photoUrl,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
