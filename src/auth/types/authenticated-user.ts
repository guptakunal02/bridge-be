import type { UserRole } from '../../database/enums';

/** Populated on `req.user` after JwtStrategy resolves the access token. */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
  role: UserRole;
  isApproved: boolean;
  /**
   * Display name — carried on the actor so activity log strings can
   * render "by Groot" / "by Alice" without a second DB lookup. Optional
   * because older session cookies minted before this field was added
   * don't carry it; actorLabel falls back to email → id when absent.
   */
  name?: string | null;
}

/** JWT access token payload — kept in sync with AuthenticatedUser. */
export interface AccessTokenPayload {
  sub: string;
  email: string | null;
  role: UserRole;
  isApproved: boolean;
}
