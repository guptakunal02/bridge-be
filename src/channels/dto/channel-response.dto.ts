import { Channel, ChannelStatus, ChannelType } from '@prisma/client';

export interface ChannelResponse {
  id: string;
  type: ChannelType;
  displayName: string;
  externalId: string | null;
  status: ChannelStatus;
  hasCredentials: boolean;
  /** SMTP/username-side address for EMAIL channels; null otherwise. */
  mailboxAddress: string | null;
  /** ISO timestamp of the most recent successful OTP verification, or null. */
  credentialsVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toChannelResponse(channel: Channel): ChannelResponse {
  return {
    id: channel.id,
    type: channel.type,
    displayName: channel.displayName,
    externalId: channel.externalId,
    status: channel.status,
    hasCredentials: channel.credentialsEncrypted !== null,
    mailboxAddress: channel.mailboxAddress,
    credentialsVerifiedAt: channel.credentialsVerifiedAt?.toISOString() ?? null,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export interface ChannelAssignmentResponse {
  userId: string;
  channelId: string;
  assignedByUserId: string;
  createdAt: string;
}
