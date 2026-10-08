import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  CreateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './dto/automation-rule.dto';
import {
  AutomationRuleResponse,
  toAutomationRuleResponse,
} from './dto/automation-rule-response.dto';
import { AutomationRule } from './entities/automation-rule.entity';
import { detectTagLoops } from './loop-validator';
import { validateCasesAndActions } from './rule-validator';

/**
 * Admin-facing CRUD for automation rules. Writes go through the
 * structural validator (rule-validator.ts) so the DB only ever
 * holds rules the engine can parse. The validator returns an
 * array of problems; we join them into a 400 BadRequest body so
 * the FE can surface every issue at once (vs. one-at-a-time
 * class-validator errors).
 */
@Injectable()
export class AutomationsService {
  constructor(
    @InjectRepository(AutomationRule)
    private readonly rules: Repository<AutomationRule>,
  ) {}

  async list(): Promise<AutomationRuleResponse[]> {
    const rows = await this.rules.find({ order: { createdAt: 'ASC' } });
    return rows.map(toAutomationRuleResponse);
  }

  async get(id: string): Promise<AutomationRuleResponse> {
    const row = await this.rules.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Automation rule not found');
    return toAutomationRuleResponse(row);
  }

  async create(dto: CreateAutomationRuleDto): Promise<AutomationRuleResponse> {
    const errors = validateCasesAndActions(dto.cases, dto.else_actions);
    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }
    const row = await this.rules.save(
      this.rules.create({
        name: dto.name,
        description: dto.description ?? null,
        enabled: dto.enabled ?? true,
        event: dto.event,
        cases: dto.cases,
        else_actions: dto.else_actions ?? [],
      }),
    );
    return this.attachWarnings(toAutomationRuleResponse(row));
  }

  async update(
    id: string,
    dto: UpdateAutomationRuleDto,
  ): Promise<AutomationRuleResponse> {
    const row = await this.rules.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Automation rule not found');

    // Validate the merged shape, not just the delta — else a stale
    // row with legacy case shape could survive a name-only PATCH.
    const nextCases = dto.cases ?? row.cases;
    const nextElse = dto.else_actions ?? row.else_actions;
    const errors = validateCasesAndActions(nextCases, nextElse);
    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

    if (dto.name !== undefined) row.name = dto.name;
    if (dto.description !== undefined) row.description = dto.description;
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.event !== undefined) row.event = dto.event;
    if (dto.cases !== undefined) row.cases = dto.cases;
    if (dto.else_actions !== undefined) row.else_actions = dto.else_actions;

    const saved = await this.rules.save(row);
    return this.attachWarnings(toAutomationRuleResponse(saved));
  }

  /**
   * Attach non-blocking loop warnings to a create/update response.
   * Recomputed on every write — the rule set is small (admin-authored,
   * dozens at most), so a full scan is well under 1ms.
   */
  private async attachWarnings(
    resp: AutomationRuleResponse,
  ): Promise<AutomationRuleResponse> {
    const all = await this.rules.find();
    const warnings = detectTagLoops(all);
    return warnings.length > 0 ? { ...resp, warnings } : resp;
  }

  async remove(id: string): Promise<void> {
    const result = await this.rules.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Automation rule not found');
    }
  }
}
