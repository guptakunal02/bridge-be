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

/**
 * Where a bot flow starts. Each trigger fires with a distinct set of
 * variables the flow can key off — e.g. `ticket.created` puts the
 * fresh sender + subject + channel into session state. `event.custom`
 * is reserved for the future proactive-campaign use case.
 */
export enum BotTrigger {
  TICKET_CREATED = 'ticket.created',
  TICKET_MESSAGE_RECEIVED = 'ticket.message.received',
  TICKET_TAG_ADDED = 'ticket.tag.added',
}

/**
 * Kind of step. Config JSONB shape depends on the kind:
 *   message  — { text,
 *                options?: [{ label, nextStepId }],
 *                timeoutSeconds?,
 *                nextStepId? }
 *              Zero options → auto-advance via nextStepId (or the
 *              linear next step at position+1).
 *              1+ options → send text + button list, wait for the
 *              customer to pick, route on that option's nextStepId.
 *   function — { functionKey, inputs, outputVariable, nextStepId }
 *   branch   — { branches: [{ conditions, nextStepId }, ...] }
 *   handoff  — { teamId?, note? }   (terminal)
 */
export enum BotStepType {
  MESSAGE = 'message',
  FUNCTION = 'function',
  BRANCH = 'branch',
  HANDOFF = 'handoff',
}

/**
 * Lifecycle of a per-ticket conversation.
 *   ACTIVE     — the runtime is driving; the customer's next reply
 *                advances the current step.
 *   COMPLETED  — the flow ended without a handoff.
 *   HANDOFF    — a handoff step fired; the ticket now sits with a
 *                team as a normal human-assigned ticket.
 *   FAILED     — an unrecoverable error (missing function, malformed
 *                config, etc.). Manual intervention required.
 */
export enum BotSessionStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  HANDOFF = 'handoff',
  FAILED = 'failed',
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
  AGENT_REPLIED = 'AGENT_REPLIED',
}

/**
 * Chosen at WAITING transition time — controls what the timer sweep
 * does when the wait elapses with no customer reply. NULL on rows
 * that are not currently WAITING (cleared on transition away).
 * Legacy WAITING rows without a value are treated as AUTO_RESOLVE
 * at read time so the sweep behaviour is unchanged for them.
 */
export enum WaitingAction {
  AUTO_RESOLVE = 'AUTO_RESOLVE',
  REOPEN = 'REOPEN',
}

/**
 * WhatsApp template categories as defined by Meta's template guidelines.
 * We only expose UTILITY + MARKETING to the create form — AUTHENTICATION
 * requires special OTP-flavoured components we don't support in V1.
 *
 * UTILITY       — transactional / service nudges (order updates, delivery
 *                 pings, re-engagement after a service touch). Cheapest
 *                 pricing tier (~₹0.11/msg in IN) and highest approval rate.
 * MARKETING     — promotional, discovery, cross-sell. Highest pricing
 *                 tier (~₹0.78/msg in IN) and strictest content review.
 * AUTHENTICATION — OTP / login codes. Not exposed in V1 UI.
 */
export enum WhatsappTemplateCategory {
  UTILITY = 'UTILITY',
  MARKETING = 'MARKETING',
  AUTHENTICATION = 'AUTHENTICATION',
}

/**
 * Mirror of Meta's template-review lifecycle. Only APPROVED rows are
 * usable in the composer picker — PENDING is still under Meta review,
 * REJECTED carries a `rejection_reason`, PAUSED means Meta flagged quality
 * (low delivery rate / high complaint rate) and send is blocked until
 * the business improves template performance.
 */
export enum WhatsappTemplateStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  PAUSED = 'PAUSED',
  DISABLED = 'DISABLED',
}

/**
 * Email templates mirror WhatsApp templates for category but don't
 * go through third-party review — the author submits and it's
 * immediately usable. We still track the category so the Outreach UI
 * can route each template to its "Utility" or "Marketing" tab,
 * matching the mental model agents built up on the WhatsApp side.
 *
 * V1 only exposes UTILITY in the UI; MARKETING is reserved for the
 * next slice (sender reputation / unsubscribe handling needs ironing
 * out before promotional email makes sense).
 */
export enum EmailTemplateCategory {
  UTILITY = 'UTILITY',
  MARKETING = 'MARKETING',
}
