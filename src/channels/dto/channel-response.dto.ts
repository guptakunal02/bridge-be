import { Channel } from '../entities/channel.entity';
import { ChannelStatus, ChannelType } from '../../database/enums';

export interface ChannelResponse {
  id: string;
  type: ChannelType;
  displayName: string;
  /**
   * Null when the admin hasn't customized the sender name. Email
   * sender then falls back to `displayName`.
   */
  senderDisplayName: string | null;
  inboxContact: string | null;
  status: ChannelStatus;
  hasCredentials: boolean;
  /** ISO timestamp of the most recent successful credential verification, or null. */
  credentialsVerifiedAt: string | null;
  /** Senders whose inbound messages are silently dropped by the ingest
   *  pipeline. See channel-muted-senders.ts for the match rules. */
  mutedSenders: string[];
  createdAt: string;
  updatedAt: string;
}

export function toChannelResponse(channel: Channel): ChannelResponse {
  return {
    id: channel.id,
    type: channel.type,
    displayName: channel.displayName,
    senderDisplayName: channel.senderDisplayName,
    inboxContact: channel.inbox_contact,
    status: channel.status,
    hasCredentials: channel.credentials_encrypted !== null,
    credentialsVerifiedAt: channel.credentialsVerifiedAt?.toISOString() ?? null,
    mutedSenders: channel.muted_senders ?? [],
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}
