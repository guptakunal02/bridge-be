export enum UserRole {
  MEMBER = 'MEMBER',
  ADMIN = 'ADMIN',
  BOT = 'BOT',
}

/**
 * Availability status drives assignment routing.
 *   ONLINE     — eligible for new auto-assignments
 *   MEETING    — no new assignments, existing tickets stay
 *   BREAK      — no new assignments, existing tickets stay
 *   EMERGENCY  — no new assignments, existing tickets bounce back to team queue
 *   OFFLINE    — no new assignments, existing tickets stay (end-of-day)
 *
 * Every non-ONLINE state has an "effective start" tracked by
 * User.status_changed_at — activity while non-ONLINE slides that
 * forward so admins see the real break/meeting boundary, not the
 * declared one.
 */
export enum UserStatus {
  ONLINE = 'ONLINE',
  MEETING = 'MEETING',
  BREAK = 'BREAK',
  EMERGENCY = 'EMERGENCY',
  OFFLINE = 'OFFLINE',
}

export enum ChannelType {
  INSTAGRAM = 'INSTAGRAM',
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
}

export enum ChannelStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
}

export enum TicketStatus {
  OPEN = 'OPEN',
  IN_FOLLOWUP = 'IN_FOLLOWUP',
  WAITING = 'WAITING',
  RESOLVED = 'RESOLVED',
}

export enum MessageDirection {
  SENT = 'SENT',
  RECEIVED = 'RECEIVED',
}

export enum TicketActivity {
  CREATED = 'CREATED',
  ASSIGNED_TO_BOT = 'ASSIGNED_TO_BOT',
  ASSIGNED_TO_AGENT = 'ASSIGNED_TO_AGENT',
  REASSIGNED_TO_AGENT = 'REASSIGNED_TO_AGENT',
  PUT_INTO_FOLLOWUP = 'PUT_INTO_FOLLOWUP',
  PUT_INTO_WAITING = 'PUT_INTO_WAITING',
  MARKED_RESOLVED = 'MARKED_RESOLVED',
  REOPENED = 'REOPENED',
  NOTES_ADDED = 'NOTES_ADDED',
  SENT_BACK_TO_QUEUE = 'SENT_BACK_TO_QUEUE',
}
