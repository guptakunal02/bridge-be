import type { UserRole } from '../../database/enums';

/** Populated on `req.user` after JwtStrategy resolves the access token. */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
  role: UserRole;
  isApproved: boolean;
}

/** JWT access token payload — kept in sync with AuthenticatedUser. */
export interface AccessTokenPayload {
  sub: string;
  email: string | null;
  role: UserRole;
  isApproved: boolean;
}
