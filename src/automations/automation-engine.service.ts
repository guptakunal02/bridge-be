import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  AUTOMATION_EVENT,
  type AutomationEventPayload,
  qualify,
} from './events';
import { RuleEvaluator } from './rule-evaluator.service';

/**
 * Public entry-point for emitting automation events + the engine's
 * listener that routes them to rule evaluation. Callers emit via
 * `engine.emit(payload)` rather than touching EventEmitter2 directly
 * — keeps the event-name constants + the "fire-and-forget on
 * failure" convention in one place.
 *
 * Emission is intentionally fire-and-forget: a slow / failing rule
 * must never block the write that triggered it. The emitting
 * caller returns to its own flow immediately; the engine evaluates
 * rules asynchronously via the EventEmitter2 queue.
 */
@Injectable()
export class AutomationEngine {
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    private readonly events: EventEmitter2,
    private readonly evaluator: RuleEvaluator,
  ) {}

  emit(payload: AutomationEventPayload): void {
    this.events.emit(qualify(payload.event), payload);
  }

  @OnEvent(qualify(AUTOMATION_EVENT.TICKET_CREATED))
  async onTicketCreated(payload: AutomationEventPayload): Promise<void> {
    await this.safeEvaluate(payload);
  }

  @OnEvent(qualify(AUTOMATION_EVENT.MESSAGE_RECEIVED))
  async onMessageReceived(payload: AutomationEventPayload): Promise<void> {
    await this.safeEvaluate(payload);
  }

  @OnEvent(qualify(AUTOMATION_EVENT.TAG_APPLIED))
  async onTagApplied(payload: AutomationEventPayload): Promise<void> {
    await this.safeEvaluate(payload);
  }

  @OnEvent(qualify(AUTOMATION_EVENT.TICKET_RESOLVED))
  async onTicketResolved(payload: AutomationEventPayload): Promise<void> {
    await this.safeEvaluate(payload);
  }

  @OnEvent(qualify(AUTOMATION_EVENT.TICKET_REOPENED))
  async onTicketReopened(payload: AutomationEventPayload): Promise<void> {
    await this.safeEvaluate(payload);
  }

  private async safeEvaluate(payload: AutomationEventPayload): Promise<void> {
    try {
      await this.evaluator.evaluate(payload);
    } catch (err) {
      // Last-ditch catch. Individual rule / action failures already
      // get swallowed inside the evaluator + dispatcher; this handles
      // the "entire evaluator crashed before even starting" case
      // (DB down, etc.) without poisoning the EventEmitter.
      this.logger.warn(
        `Automation evaluate crashed for event=${payload.event} ticket=${payload.ticket.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
