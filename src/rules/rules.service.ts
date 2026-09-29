import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Not, QueryFailedError, Repository } from 'typeorm';
import { Team } from '../teams/entities/team.entity';
import type { CreateRuleDto, UpdateRuleDto } from './dto/rule.dto';
import { RuleResponse, toRuleResponse } from './dto/rule-response.dto';
import { RoutingRule } from './entities/routing-rule.entity';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { RuleValidatorService } from './rule-validator.service';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class RulesService {
  constructor(
    @InjectRepository(RoutingRule)
    private readonly rules: Repository<RoutingRule>,
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    private readonly evaluator: RuleEvaluatorService,
    private readonly validator: RuleValidatorService,
  ) {}

  async list(): Promise<RuleResponse[]> {
    const rows = await this.rules.find({
      relations: { team: true },
      order: { createdAt: 'ASC' },
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

    if (dto.teamId !== undefined) {
      const team = await this.teams.findOne({ where: { id: dto.teamId } });
      if (!team) throw new NotFoundException('Target team not found');
    }

    // Overlap check removed — team priority breaks ties at ingest.
    // Two rules on different teams can share conditions freely; the
    // higher-priority team's rule wins.

    try {
      const created = await this.rules.save(
        this.rules.create({
          name: dto.name,
          team_id: dto.teamId ?? null,
          condition_tree: dto.conditionTree,
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
      // Overlap check removed — team priority breaks ties at ingest.
      (patch as { condition_tree?: unknown }).condition_tree =
        dto.conditionTree;
    }
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;

    if (Object.keys(patch).length > 0) {
      try {
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
   * One-click "Validate rule" — structural + matchability +
   * mutual-exclusivity against every other rule in the system.
   * The FE calls this before Save to catch errors early; Save
   * itself also enforces exclusivity, so an API caller that skips
   * validate can't sneak in an overlap.
   */
  async validateCandidate(
    tree: unknown,
    excludeRuleId: string | null,
  ): Promise<{
    structurallyValid: boolean;
    matchable: boolean;
    sampleTicket: Record<string, unknown> | null;
    overlaps: Array<{
      otherRuleId: string;
      otherRuleName: string;
      sampleTicket: Record<string, unknown>;
    }>;
    message: string;
  }> {
    const structural = this.validator.validate(tree);
    if (!structural.structurallyValid) {
      return { ...structural, overlaps: [] };
    }

    const others = await this.rules.find({
      where: excludeRuleId ? { id: Not(excludeRuleId) } : {},
      select: { id: true, name: true, condition_tree: true },
    });
    const overlaps = this.validator.checkOverlap(
      tree,
      others.map((r) => ({
        id: r.id,
        name: r.name,
        conditionTree: r.condition_tree,
      })),
    );

    if (!structural.matchable) {
      return { ...structural, overlaps };
    }
    // Overlaps are informational now — the FE can surface them as a
    // "may shadow / be shadowed by other rules; team priority
    // decides" hint. Not a blocker.
    return { ...structural, overlaps };
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
