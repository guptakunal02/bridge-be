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
import { AutomationsService } from './automations.service';
import type { AutomationRuleResponse } from './dto/automation-rule-response.dto';
import {
  CreateAutomationRuleDto,
  UpdateAutomationRuleDto,
} from './dto/automation-rule.dto';

/**
 * Admin-only CRUD for automation rules. The engine subscribes to
 * events directly; this controller is only the "author rules in
 * the UI" surface.
 */
@Controller('automations')
@Roles(UserRole.ADMIN)
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  list(): Promise<AutomationRuleResponse[]> {
    return this.automations.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AutomationRuleResponse> {
    return this.automations.get(id);
  }

  @Post()
  create(@Body() dto: CreateAutomationRuleDto): Promise<AutomationRuleResponse> {
    return this.automations.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAutomationRuleDto,
  ): Promise<AutomationRuleResponse> {
    return this.automations.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.automations.remove(id);
  }
}
