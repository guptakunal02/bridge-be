import { User } from '../entities/user.entity';
import { UserRole, UserStatus } from '../../database/enums';

export interface UserResponse {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  status: UserStatus;
  /** Effective start of the current status — slides forward with activity while non-ONLINE. */
  statusChangedAt: string;
  photoUrl: string | null;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
  /**
   * True for admin-invited users who haven't completed their first
   * Google sign-in yet (row exists with no googleSub, isApproved
   * pre-set to true). Powers the "PENDING" pill on the Team page.
   * Flips to false the moment the invitee lands via OAuth.
   */
  isPending: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Extends UserResponse with delivery status for the invite email.
 * `emailSent = false` means the row was created (invitee will still
 * be able to sign in) but the outbound mail failed or no eligible
 * sender inbox exists — the FE should surface a "share the link"
 * fallback message.
 */
export interface InviteUserResponse extends UserResponse {
  emailSent: boolean;
}

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    statusChangedAt: user.status_changed_at.toISOString(),
    photoUrl: user.photoUrl,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
    isPending: user.googleSub === null && user.role !== 'BOT',
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
