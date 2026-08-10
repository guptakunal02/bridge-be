// Internal channel-lifecycle events. Distinct from realtime/events.ts
// (which is client-facing). Consumed by EmailInboxManager and, later, by
// any adapter that needs to react to channel changes (Meta OAuth refresh,
// WhatsApp session state, etc.).

export const CHANNEL_EVENTS = {
  Saved: 'channel.saved',
  Deleted: 'channel.deleted',
} as const;

export interface ChannelSavedEvent {
  channelId: string;
}

export interface ChannelDeletedEvent {
  channelId: string;
}
