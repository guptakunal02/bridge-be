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
import { CreateRuleDto, TestRuleDto, UpdateRuleDto } from './dto/rule.dto';
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
   * Dry-run: evaluate this rule against a hand-crafted context.
   * Returns { matched: boolean } so the FE can show green/red.
   */
  @Post(':id/test')
  async testMatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestRuleDto,
  ): Promise<{ matched: boolean }> {
    const matched = await this.rules.testMatch(id, dto.context);
    return { matched };
  }

  /**
   * Dry-run against an unsaved condition tree — used while the admin
   * is still editing in the builder.
   */
  @Post('test-tree')
  testTree(
    @Body() body: { conditionTree: unknown; context: Record<string, unknown> },
  ): { matched: boolean } {
    const matched = this.rules.testTree(body.conditionTree, body.context);
    return { matched };
  }
}
