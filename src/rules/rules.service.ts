import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryFailedError, Repository } from 'typeorm';
import { Team } from '../teams/entities/team.entity';
import type { CreateRuleDto, UpdateRuleDto } from './dto/rule.dto';
import { RuleResponse, toRuleResponse } from './dto/rule-response.dto';
import { RoutingRule } from './entities/routing-rule.entity';
import {
  ConditionTree,
  RuleEvaluatorService,
  TicketContext,
} from './rule-evaluator.service';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class RulesService {
  constructor(
    @InjectRepository(RoutingRule)
    private readonly rules: Repository<RoutingRule>,
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  async list(): Promise<RuleResponse[]> {
    const rows = await this.rules.find({
      relations: { team: true },
      order: { priority: 'ASC', createdAt: 'ASC' },
    });
    return rows.map(toRuleResponse);
  }

  async get(id: string): Promise<RuleResponse> {
    const rule = await this.rules.findOne({
      where: { id },
      relations: { team: true },
    });
    if (!rule) throw new NotFoundException('Rule not found');
    return toRuleResponse(rule);
  }

  async create(dto: CreateRuleDto): Promise<RuleResponse> {
    this.evaluator.validate(dto.conditionTree);
    const team = await this.teams.findOne({ where: { id: dto.teamId } });
    if (!team) throw new NotFoundException('Target team not found');
    try {
      const created = await this.rules.save(
        this.rules.create({
          name: dto.name,
          team_id: dto.teamId,
          condition_tree: dto.conditionTree,
          priority: dto.priority ?? 100,
          is_active: dto.isActive ?? true,
        }),
      );
      return this.get(created.id);
    } catch (err) {
      throw translateUniqueError(err);
    }
  }

  async update(id: string, dto: UpdateRuleDto): Promise<RuleResponse> {
    const rule = await this.rules.findOne({ where: { id } });
    if (!rule) throw new NotFoundException('Rule not found');

    const patch: DeepPartial<RoutingRule> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.teamId !== undefined) {
      const team = await this.teams.findOne({ where: { id: dto.teamId } });
      if (!team) throw new NotFoundException('Target team not found');
      patch.team_id = dto.teamId;
    }
    if (dto.conditionTree !== undefined) {
      this.evaluator.validate(dto.conditionTree);
      // The jsonb column is typed `unknown` on the entity; TypeORM's
      // DeepPartial rejects that through its own type gymnastics, so
      // we widen locally.
      (patch as { condition_tree?: unknown }).condition_tree =
        dto.conditionTree;
    }
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;

    if (Object.keys(patch).length > 0) {
      try {
        // Cast around the `unknown` on condition_tree — TypeORM's
        // deep-partial helper wants a concrete type for jsonb columns
        // even though Postgres will happily accept any shape.
        await this.rules.update(
          { id },
          patch as unknown as Parameters<typeof this.rules.update>[1],
        );
      } catch (err) {
        throw translateUniqueError(err);
      }
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const result = await this.rules.delete({ id });
    if (!result.affected) throw new NotFoundException('Rule not found');
  }

  /**
   * Evaluate a rule against a hand-crafted context. Powers the
   * "Test" panel in the rule builder so admins can sanity-check a
   * tree before saving.
   */
  async testMatch(id: string, ctx: TicketContext): Promise<boolean> {
    const rule = await this.rules.findOne({ where: { id } });
    if (!rule) throw new NotFoundException('Rule not found');
    const tree = rule.condition_tree as ConditionTree;
    return this.evaluator.evaluate(tree, ctx);
  }

  /**
   * Test an unsaved tree — used by the builder before the rule is
   * persisted. Validates first, then evaluates.
   */
  testTree(tree: unknown, ctx: TicketContext): boolean {
    this.evaluator.validate(tree);
    return this.evaluator.evaluate(tree, ctx);
  }
}

function translateUniqueError(err: unknown): Error {
  if (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
  ) {
    return new ConflictException('A rule with that name already exists.');
  }
  return err as Error;
}
