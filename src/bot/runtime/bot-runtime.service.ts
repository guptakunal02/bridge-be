import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, DataSource, Repository } from 'typeorm';
import {
  BotSessionStatus,
  BotStepType,
  BotTrigger,
  TicketActivity,
} from '../../database/enums';
import { RuleEvaluatorService } from '../../rules/rule-evaluator.service';
import type { ConditionTree } from '../../rules/rule-evaluator.service';
import { Ticket } from '../../tickets/entities/ticket.entity';
import { TicketActivityLog } from '../../tickets/entities/ticket-activity-log.entity';
import { BotFlow } from '../entities/bot-flow.entity';
import { BotSession } from '../entities/bot-session.entity';
import { BotStep } from '../entities/bot-step.entity';
import { BotFunctionsService } from '../functions/bot-functions.service';
import { StepConfigValidator } from '../flows/step-config-validator.service';
import type { ChannelAdapter } from './channel-adapter';
import { CHANNEL_ADAPTER } from './channel-adapter.token';
import { renderText, renderValue } from './template';
import type {
  BranchStepConfig,
  FunctionStepConfig,
  HandoffStepConfig,
  MessageStepConfig,
} from './types';

/**
 * Max non-blocking steps we'll advance in a single tick before
 * bailing. Guards against message/function/branch cycles the config
 * validator can't statically catch (a branch's default arm pointing
 * at a step upstream of itself, for instance).
 */
const MAX_TICKS = 25;

/**
 * The engine that drives BotSessions forward.
 *
 * Two public entry points:
 *
 *   startSession(...)         — a trigger fired; find the flow that
 *                               claims this event, spin up a session,
 *                               and tick until we hit a blocking step
 *                               or a terminal one.
 *   handleCustomerReply(...)  — an inbound message arrived on a
 *                               ticket that has an ACTIVE session
 *                               parked on a question step. Match the
 *                               reply to an option, store it, then
 *                               resume ticking.
 *
 * The internal `tick()` loop is where step execution happens; the
 * two public entry points differ only in how they set up before
 * calling into it.
 */
@Injectable()
export class BotRuntimeService {
  private readonly logger = new Logger(BotRuntimeService.name);

  constructor(
    @InjectRepository(BotFlow)
    private readonly flows: Repository<BotFlow>,
    @InjectRepository(BotStep)
    private readonly steps: Repository<BotStep>,
    @InjectRepository(BotSession)
    private readonly sessions: Repository<BotSession>,
    private readonly evaluator: RuleEvaluatorService,
    private readonly functions: BotFunctionsService,
    private readonly configValidator: StepConfigValidator,
    private readonly dataSource: DataSource,
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Public entry points                                                 */
  /* ------------------------------------------------------------------ */

  async startSession(input: {
    ticketId: string;
    channelId: string;
    trigger: BotTrigger;
    initialVariables: Record<string, unknown>;
  }): Promise<BotSession | null> {
    const flow = await this.pickFlow(input.trigger, input.initialVariables);
    if (!flow || !flow.first_step_id) return null;

    // Guard: if the ticket already has a live session, don't stack a
    // second one on top. The trigger fired at a moment that's already
    // being driven by the bot; ignore.
    const existing = await this.sessions.findOne({
      where: { ticket_id: input.ticketId },
    });
    if (existing) return existing;

    const session = await this.sessions.save(
      this.sessions.create({
        ticket_id: input.ticketId,
        flow_id: flow.id,
        current_step_id: flow.first_step_id,
        variables: input.initialVariables,
        status: BotSessionStatus.ACTIVE,
      }),
    );
    await this.tick(session, input.channelId);
    return session;
  }

  /**
   * Called from the channel ingest path when a message lands on a
   * ticket that already has an ACTIVE session parked on a question.
   * If the ticket has no active session, this is a no-op.
   */
  async handleCustomerReply(input: {
    ticketId: string;
    channelId: string;
    replyText: string;
  }): Promise<void> {
    const session = await this.sessions.findOne({
      where: { ticket_id: input.ticketId, status: BotSessionStatus.ACTIVE },
    });
    if (!session || !session.current_step_id) return;

    const step = await this.steps.findOne({
      where: { id: session.current_step_id },
    });
    if (!step || step.type !== BotStepType.MESSAGE) return;

    const cfg = step.config as MessageStepConfig;
    // Only messages with reply options wait for a reply. A plain
    // (options-less) message wouldn't have blocked the runtime here
    // in the first place, so this reply isn't for us.
    if (!cfg.options || cfg.options.length === 0) return;

    const normalised = input.replyText.trim().toLowerCase();
    const match = cfg.options.find(
      (o) => o.label.trim().toLowerCase() === normalised,
    );

    if (!match) {
      // Unknown answer — resend the question. Later we could count
      // retries and hand off after N misses; MVP just repeats.
      await this.sendStep(
        input.ticketId,
        input.channelId,
        step,
        session.variables,
      );
      return;
    }

    session.variables = {
      ...session.variables,
      __last_answer: match.label,
    };
    session.current_step_id = match.nextStepId;
    await this.sessions.save(session);
    await this.tick(session, input.channelId);
  }

  /* ------------------------------------------------------------------ */
  /* Internal                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Pick the first flow that claims the trigger event and whose
   * trigger_conditions accept the initial variable context.
   */
  private async pickFlow(
    trigger: BotTrigger,
    variables: Record<string, unknown>,
  ): Promise<BotFlow | null> {
    const candidates = await this.flows.find({
      where: { trigger, is_active: true },
      order: { createdAt: 'ASC' },
    });
    for (const flow of candidates) {
      const conditions = flow.trigger_conditions;
      if (conditions === null || conditions === undefined) return flow;
      try {
        if (this.evaluator.evaluate(conditions as ConditionTree, variables)) {
          return flow;
        }
      } catch (err) {
        // Malformed conditions on an active flow — log and skip so
        // one broken flow doesn't block others from firing.
        this.logger.warn(
          `Flow ${flow.id} has invalid trigger conditions: ${(err as Error).message}`,
        );
      }
    }
    return null;
  }

  /**
   * Drive the session forward until it either blocks on a question,
   * finishes at a handoff / terminal, or hits the loop guard. Every
   * transition persists the session so a crash never leaves us
   * pointing at a stale step.
   */
  private async tick(session: BotSession, channelId: string): Promise<void> {
    for (let iter = 0; iter < MAX_TICKS; iter++) {
      if (session.current_step_id === null) {
        session.status = BotSessionStatus.COMPLETED;
        await this.sessions.save(session);
        return;
      }
      const step = await this.steps.findOne({
        where: { id: session.current_step_id },
      });
      if (!step) {
        this.logger.warn(
          `Session ${session.id} points at missing step ${session.current_step_id ?? '(null)'}; marking FAILED`,
        );
        session.status = BotSessionStatus.FAILED;
        session.current_step_id = null;
        await this.sessions.save(session);
        return;
      }

      try {
        // Strict mode: at execution time every required field must
        // be filled. Scaffolds are legal at save-time (so the FE
        // builder can create and edit) but not at run-time.
        this.configValidator.validate(step.type, step.config, true);
      } catch (err) {
        this.logger.error(
          `Session ${session.id} step ${step.id} has invalid config: ${(err as Error).message}`,
        );
        session.status = BotSessionStatus.FAILED;
        await this.sessions.save(session);
        return;
      }

      switch (step.type) {
        case BotStepType.MESSAGE: {
          const cfg = step.config as MessageStepConfig;
          await this.sendStep(
            session.ticket_id,
            channelId,
            step,
            session.variables,
          );
          if (cfg.options && cfg.options.length > 0) {
            // Message with reply buttons — block. handleCustomerReply
            // matches the reply to an option label and advances via
            // that option's nextStepId.
            return;
          }
          // Plain message — auto-advance to nextStepId (or the linear
          // position + 1 fallback).
          session.current_step_id = await this.resolveLinearNext(
            step,
            cfg.nextStepId,
          );
          await this.sessions.save(session);
          break;
        }

        case BotStepType.FUNCTION: {
          const cfg = step.config as FunctionStepConfig;
          const inputs = renderValue(
            cfg.inputs ?? {},
            session.variables,
          ) as Record<string, unknown>;
          try {
            const output = await this.functions.invoke(cfg.functionKey, inputs);
            session.variables = {
              ...session.variables,
              [cfg.outputVariable]: output,
            };
            session.current_step_id = await this.resolveLinearNext(
              step,
              cfg.nextStepId,
            );
            await this.sessions.save(session);
          } catch (err) {
            this.logger.error(
              `Function ${cfg.functionKey} threw during session ${session.id}: ${(err as Error).message}`,
            );
            session.status = BotSessionStatus.FAILED;
            await this.sessions.save(session);
            return;
          }
          break;
        }

        case BotStepType.BRANCH: {
          const cfg = step.config as BranchStepConfig;
          let taken = false;
          for (const branch of cfg.branches) {
            if (branch.conditions === undefined || branch.conditions === null) {
              session.current_step_id = branch.nextStepId;
              taken = true;
              break;
            }
            if (this.evaluator.evaluate(branch.conditions, session.variables)) {
              session.current_step_id = branch.nextStepId;
              taken = true;
              break;
            }
          }
          if (!taken) {
            // No default arm and nothing matched — nothing sensible to
            // do. Treat as end-of-flow.
            session.current_step_id = null;
          }
          await this.sessions.save(session);
          break;
        }

        case BotStepType.HANDOFF: {
          const cfg = step.config as HandoffStepConfig;
          await this.applyHandoff(session, cfg);
          return;
        }
      }
    }

    this.logger.error(
      `Session ${session.id} exceeded ${MAX_TICKS} step transitions; marking FAILED`,
    );
    session.status = BotSessionStatus.FAILED;
    await this.sessions.save(session);
  }

  /**
   * "What comes next after this linear step?"
   *   - config.nextStepId explicitly set → use it
   *   - otherwise → whatever step sits at position + 1 in the flow
   *   - nothing at position + 1 → end of flow (null)
   */
  private async resolveLinearNext(
    step: BotStep,
    explicitNextId: string | undefined,
  ): Promise<string | null> {
    if (explicitNextId) return explicitNextId;
    const next = await this.steps.findOne({
      where: { flow_id: step.flow_id, position: step.position + 1 },
    });
    return next?.id ?? null;
  }

  private async sendStep(
    ticketId: string,
    channelId: string,
    step: BotStep,
    variables: Record<string, unknown>,
  ): Promise<void> {
    if (step.type !== BotStepType.MESSAGE) return;
    const cfg = step.config as MessageStepConfig;
    const options = cfg.options?.length
      ? cfg.options.map((o) => ({ label: renderText(o.label, variables) }))
      : undefined;
    await this.channel.send({
      ticketId,
      channelId,
      message: {
        text: renderText(cfg.text, variables),
        options,
      },
    });
  }

  private async applyHandoff(
    session: BotSession,
    cfg: HandoffStepConfig,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr: EntityManager) => {
      const ticketRepo = mgr.getRepository(Ticket);
      const logRepo = mgr.getRepository(TicketActivityLog);
      const sessionRepo = mgr.getRepository(BotSession);

      if (cfg.teamId) {
        await ticketRepo.update(
          { id: session.ticket_id },
          { team_id: cfg.teamId },
        );
      }
      await logRepo.save({
        ticket_id: session.ticket_id,
        event: TicketActivity.SENT_BACK_TO_QUEUE,
        actor_id: null,
        log: cfg.note
          ? `Bot handed off to team: ${cfg.note}`
          : 'Bot handed off to team',
      });

      session.status = BotSessionStatus.HANDOFF;
      session.current_step_id = null;
      await sessionRepo.save(session);
    });
  }
}
