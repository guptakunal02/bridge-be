import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotStepType } from '../../database/enums';
import { BotFlow } from './bot-flow.entity';

/**
 * A single node in a bot flow. `type` decides how the runtime
 * executes it and what shape `config` must carry:
 *
 *   message   — { text, nextStepId? }
 *                Send a WhatsApp/channel message. `text` may contain
 *                ${variable.path} substitutions.
 *   question  — { text, options: [{ label, nextStepId }], timeoutSec? }
 *                Sends the text with option buttons; each option
 *                explicitly names the next step.
 *   function  — { functionKey, inputs, outputVariable, nextStepId? }
 *                Calls a registered function (see BotFunctionsService)
 *                and writes its return object under `outputVariable`
 *                in the session variables map.
 *   branch    — { branches: [{ conditions: ConditionTree, nextStepId },
 *                             { nextStepId }] }
 *                Evaluates each branch's ConditionTree against session
 *                variables (same evaluator rules use); first match
 *                wins. Last entry with no `conditions` = default/else.
 *   handoff   — { teamId?, note? }
 *                Terminal. Sets ticket.team_id (or leaves it) and
 *                marks the session as HANDOFF.
 *
 * `position` is a display / linear-order key. For step types with an
 * implicit "just fall through to the next step" behaviour (message /
 * function when no nextStepId is set) the runtime picks the step at
 * position + 1 within the same flow.
 */
@Entity({ name: 'bot_step' })
@Index(['flow_id', 'position'])
export class BotStep {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'flow_id' })
  flow_id!: string;

  @ManyToOne(() => BotFlow, (f) => f.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'flow_id' })
  flow!: BotFlow;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ type: 'enum', enum: BotStepType })
  type!: BotStepType;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  config!: unknown;

  /**
   * Where this node sits on the visual builder canvas. Purely a UI
   * concern — the runtime doesn't read it. Nodes without an
   * explicit position get {x: 0, y: 0}; the FE snaps them into a
   * sensible spot on first drag.
   */
  @Column({
    type: 'jsonb',
    name: 'canvas_position',
    default: () => `'{"x": 0, "y": 0}'`,
  })
  canvas_position!: { x: number; y: number };

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
