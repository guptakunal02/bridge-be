import { Channel, ChannelStatus, ChannelType } from '@prisma/client';

export interface ChannelResponse {
  id: string;
  type: ChannelType;
  displayName: string;
  externalId: string | null;
  status: ChannelStatus;
  hasCredentials: boolean;
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
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export interface ChannelAssignmentResponse {
  agentId: string;
  channelId: string;
  assignedByAgentId: string;
  createdAt: string;
}
