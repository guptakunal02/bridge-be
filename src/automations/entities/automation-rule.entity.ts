import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A single automation rule. Fires in response to one `event` (e.g.
 * `tag.applied`); the engine loads every enabled rule for an event,
 * evaluates each case's conditions, and runs the matching case's
 * actions. All matching cases run — order of cases is UI/author
 * convention only (first-match-wins is NOT the semantic). `else`
 * runs iff zero cases matched.
 *
 * `cases` + `else_actions` are stored as jsonb so the shape can
 * evolve without a migration per predicate/action variant added.
 * Shape is validated at the DTO layer (create/update) and at
 * engine load time, so a malformed row can never silently fire.
 */
@Entity({ name: 'automation_rule' })
@Index(['event', 'enabled'])
export class AutomationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /**
   * Event this rule subscribes to. One of the AutomationEvent string
   * literals — stored as text (not enum) so adding a new event type
   * doesn't require a Postgres enum migration. The engine ignores
   * unknown events at load time.
   */
  @Column({ type: 'text' })
  event!: string;

  /**
   * Ordered list of `{ conditions: Predicate[], actions: Action[] }`.
   * All cases are evaluated independently; a case runs its actions
   * when every condition is TRUE (AND semantics within a case).
   */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  cases!: unknown;

  /**
   * Actions that fire only when ZERO cases matched. Default empty.
   */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb`, name: 'else_actions' })
  else_actions!: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
