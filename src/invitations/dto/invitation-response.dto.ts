import { AgentRole, Invitation } from '@prisma/client';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InvitationResponse {
  id: string;
  email: string;
  role: AgentRole;
  status: InvitationStatus;
  invitedById: string;
  channelIds: string[];
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateInvitationResponse extends InvitationResponse {
  // Only returned once — never persisted. Callers must send this to the invitee.
  acceptUrl: string;
  // Whether the SystemMailer successfully emailed the invite. False when no
  // CONNECTED EMAIL channel is configured, or the SMTP send failed. Admin UX
  // uses this to show "email sent" vs "share this link".
  emailSent: boolean;
}

export function computeInvitationStatus(inv: Invitation): InvitationStatus {
  if (inv.acceptedAt) return 'ACCEPTED';
  if (inv.revokedAt) return 'REVOKED';
  if (inv.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'PENDING';
}

export function toInvitationResponse(inv: Invitation): InvitationResponse {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: computeInvitationStatus(inv),
    invitedById: inv.invitedById,
    channelIds: inv.channelIds,
    expiresAt: inv.expiresAt.toISOString(),
    acceptedAt: inv.acceptedAt?.toISOString() ?? null,
    revokedAt: inv.revokedAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}
