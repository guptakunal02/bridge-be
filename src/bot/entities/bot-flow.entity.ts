import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotTrigger } from '../../database/enums';
import { BotStep } from './bot-step.entity';

/**
 * A named flow. Fires whenever its `trigger` event fires and the
 * `trigger_conditions` tree (if any) evaluates true. The runtime
 * spins up a BotSession keyed to the affected ticket and starts
 * driving from `first_step`.
 *
 * `first_step_id` is nullable so admins can save a draft before
 * they've added any steps. A flow with `first_step_id IS NULL`
 * doesn't route anything — the runtime skips it.
 */
@Entity({ name: 'bot_flow' })
@Index(['trigger', 'is_active'])
export class BotFlow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'enum', enum: BotTrigger })
  trigger!: BotTrigger;

  /**
   * Optional ConditionTree — same shape rules use. Null means "fire
   * every time the trigger fires."
   */
  @Column({ type: 'jsonb', nullable: true, name: 'trigger_conditions' })
  trigger_conditions!: unknown;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  is_active!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'first_step_id' })
  first_step_id!: string | null;

  @OneToOne(() => BotStep, { nullable: true })
  @JoinColumn({ name: 'first_step_id' })
  firstStep!: BotStep | null;

  @OneToMany(() => BotStep, (s) => s.flow)
  steps!: BotStep[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
