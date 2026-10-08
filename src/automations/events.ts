import { TicketStatus } from '../database/enums';

/**
 * V1 automation events. String literals (not an enum) so the DB
 * column + JSON payloads stay human-readable. Add a new entry here
 * when a new emission site is wired — the engine ignores any
 * rule whose `event` doesn't match a key below.
 *
 * Each event carries a fixed payload shape (TicketSnapshot + the
 * event-specific extras) — the predicate evaluator reads from
 * `event.*` for the extras and `ticket.*` for the snapshot. Keeping
 * both in the payload means the engine stays stateless (no DB
 * read on dispatch) and the predicate can see the ticket exactly
 * as the caller saw it when they emitted.
 */
export const AUTOMATION_EVENT = {
  TICKET_CREATED: 'ticket.created',
  MESSAGE_RECEIVED: 'message.received',
  TAG_APPLIED: 'tag.applied',
  TICKET_RESOLVED: 'ticket.resolved',
  TICKET_REOPENED: 'ticket.reopened',
} as const;

export type AutomationEventName =
  (typeof AUTOMATION_EVENT)[keyof typeof AUTOMATION_EVENT];

/**
 * Snapshot of the ticket at the moment an event was emitted. The
 * caller passes this through so predicates on `ticket.*` fields
 * evaluate against the exact state the caller saw — no race
 * window where the engine would reload and see a mutated row.
 */
export interface TicketSnapshot {
  id: string;
  channelId: string;
  status: TicketStatus;
  tags: string[];
  assigneeId: string | null;
  teamId: string;
  /** Subject of the first message on the ticket. */
  subject: string | null;
}

export interface TicketCreatedEventPayload {
  ticketId: string;
  channelId: string;
  sender: string | null;
  subject: string | null;
  body: string;
  /** Hour of the day (0-23) in IST at the moment the ticket was
   *  created. Convenience for OOH-style predicates. */
  hourIst: number;
}

export interface MessageReceivedEventPayload {
  ticketId: string;
  messageId: string;
  channelId: string;
  sender: string | null;
  subject: string | null;
  body: string;
  hourIst: number;
}

export interface TagAppliedEventPayload {
  ticketId: string;
  /** The tag that was JUST applied — predicates key off this value,
   *  not off the ticket's full tag set. Lets a rule distinguish
   *  "urgent was added" from "escalated was added" without reading
   *  the whole tags[] array. */
  tagName: string;
}

/**
 * Fires when a ticket's status transitions INTO RESOLVED (from any
 * non-resolved status). Predicates can key off `previousStatus` to
 * distinguish "resolved from OPEN" vs "resolved from WAITING".
 */
export interface TicketResolvedEventPayload {
  ticketId: string;
  previousStatus: TicketStatus;
  hourIst: number;
}

/**
 * Fires when a RESOLVED ticket transitions back to a non-resolved
 * status (OPEN / WAITING / IN_FOLLOWUP). Covers both the manual
 * agent "Reopen" button and the ingest-driven reopen (customer
 * replies to a resolved ticket within the configured window).
 */
export interface TicketReopenedEventPayload {
  ticketId: string;
  newStatus: TicketStatus;
  hourIst: number;
}

export type AutomationEventPayload =
  | {
      event: typeof AUTOMATION_EVENT.TICKET_CREATED;
      ticket: TicketSnapshot;
      payload: TicketCreatedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.MESSAGE_RECEIVED;
      ticket: TicketSnapshot;
      payload: MessageReceivedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.TAG_APPLIED;
      ticket: TicketSnapshot;
      payload: TagAppliedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.TICKET_RESOLVED;
      ticket: TicketSnapshot;
      payload: TicketResolvedEventPayload;
    }
  | {
      event: typeof AUTOMATION_EVENT.TICKET_REOPENED;
      ticket: TicketSnapshot;
      payload: TicketReopenedEventPayload;
    };

/** EventEmitter2 wildcard target for the automation engine's listener. */
export const AUTOMATION_EVENT_WILDCARD = 'automation.*';

/**
 * Internal namespace prefix for the EventEmitter2 bus. Separates
 * these from PRESENCE_EVENTS and any future namespaces.
 */
export function qualify(event: AutomationEventName): string {
  return `automation.${event}`;
}
