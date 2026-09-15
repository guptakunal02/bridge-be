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
import { Team } from '../../teams/entities/team.entity';

/**
 * A named condition tree that routes matching tickets to a team.
 *
 * The tree is stored as JSONB — every entry:
 *   {
 *     groups: [
 *       { conditions: [ { attribute, operator, value }, ... ] },
 *       ...
 *     ]
 *   }
 * Groups are OR'd, conditions within a group are AND'd. Two-level
 * nesting only; no arbitrary depth. Validation lives in the service.
 *
 * Ordering: rules evaluate in createdAt ASC (oldest first) — no
 * priority column. Rules are equal-weight; admins are expected to
 * keep their condition trees mutually exclusive. `is_active = false`
 * skips the rule entirely — useful for pausing without losing the
 * definition.
 */
@Entity({ name: 'routing_rule' })
@Index(['is_active', 'createdAt'])
export class RoutingRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  name!: string;

  @Column({ type: 'uuid', name: 'team_id' })
  team_id!: string;

  @ManyToOne(() => Team, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'team_id' })
  team!: Team;

  @Column({ type: 'jsonb', name: 'condition_tree' })
  condition_tree!: unknown;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  is_active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
