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
import { RuleValidatorService } from './rule-validator.service';
import type { ValidationResult } from './rule-validator.service';
import { RulesService } from './rules.service';

@Controller('rules')
@Roles(UserRole.ADMIN)
export class RulesController {
  constructor(
    private readonly rules: RulesService,
    private readonly evaluator: RuleEvaluatorService,
    private readonly validator: RuleValidatorService,
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
   * One-click auto-validate. Synthesises a matching ticket in memory
   * (no DB write) and confirms the evaluator agrees. Reports whether
   * the tree is structurally valid AND actually matchable — the two
   * together are the "green tick" the FE surfaces.
   */
  @Post('validate')
  validate(@Body() dto: ValidateRuleDto): ValidationResult {
    return this.validator.validate(dto.conditionTree);
  }
}
