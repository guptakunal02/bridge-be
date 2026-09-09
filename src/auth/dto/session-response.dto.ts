import { UserRole } from '../../database/enums';

export interface SessionUserResponse {
  id: string;
  email: string | null;
  name: string;
  phone: string | null;
  photoUrl: string | null;
  role: UserRole;
  isApproved: boolean;
}

export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: SessionUserResponse;
}
