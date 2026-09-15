import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../database/enums';
import type { AttributeDefinition } from './attributes';
import { CreateRuleDto, UpdateRuleDto, ValidateRuleDto } from './dto/rule.dto';
import { RuleResponse } from './dto/rule-response.dto';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { RulesService } from './rules.service';

@Controller('rules')
@Roles(UserRole.ADMIN)
export class RulesController {
  constructor(
    private readonly rules: RulesService,
    private readonly evaluator: RuleEvaluatorService,
  ) {}

  /**
   * Registry snapshot for the FE condition builder — attributes,
   * their type, and the operators that make sense for each.
   */
  @Get('attributes')
  attributes(): readonly AttributeDefinition[] {
    return this.evaluator.attributes();
  }

  @Get()
  list(): Promise<RuleResponse[]> {
    return this.rules.list();
  }

  @Post()
  create(@Body() dto: CreateRuleDto): Promise<RuleResponse> {
    return this.rules.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<RuleResponse> {
    return this.rules.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRuleDto,
  ): Promise<RuleResponse> {
    return this.rules.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.rules.remove(id);
  }

  /**
   * One-click auto-validate. Runs three checks in one round trip:
   *   1. Structural validation (attributes, operators, value types)
   *   2. Matchability (a synthesised ticket exists that fires it)
   *   3. Mutual exclusivity vs every other rule in the system
   *
   * When editing an existing rule, the caller passes ruleId so the
   * overlap check excludes it from the "others" set. Nothing is
   * persisted — no synthetic ticket ever hits the DB.
   */
  @Post('validate')
  async validate(
    @Body() dto: ValidateRuleDto,
  ): Promise<ReturnType<RulesService['validateCandidate']>> {
    return this.rules.validateCandidate(dto.conditionTree, dto.ruleId ?? null);
  }
}
