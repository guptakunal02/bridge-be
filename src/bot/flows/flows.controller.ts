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
import { Roles } from '../../auth/decorators/roles.decorator';
import { BotTrigger, UserRole } from '../../database/enums';
import type { FlowDetail, FlowResponse } from './dto/flow-response.dto';
import { CreateFlowDto } from './dto/create-flow.dto';
import { CreateStepDto, ReorderStepsDto, UpdateStepDto } from './dto/step.dto';
import { UpdateFlowDto } from './dto/update-flow.dto';
import { FlowsService } from './flows.service';

@Controller('bot/flows')
@Roles(UserRole.ADMIN)
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  /**
   * Registry of trigger events + human labels for the FE modal's
   * dropdown. Kept as an endpoint (rather than hard-coded in the FE)
   * so growing the BotTrigger enum on the backend is a single-repo
   * change.
   */
  @Get('triggers')
  triggers(): Array<{ key: BotTrigger; label: string }> {
    return [
      { key: BotTrigger.TICKET_CREATED, label: 'New ticket opened' },
      {
        key: BotTrigger.TICKET_MESSAGE_RECEIVED,
        label: 'Customer sent a message on an existing ticket',
      },
      { key: BotTrigger.TICKET_TAG_ADDED, label: 'Tag added to a ticket' },
    ];
  }

  @Get()
  list(): Promise<FlowResponse[]> {
    return this.flows.list();
  }

  @Post()
  create(@Body() dto: CreateFlowDto): Promise<FlowResponse> {
    return this.flows.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<FlowDetail> {
    return this.flows.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFlowDto,
  ): Promise<FlowResponse> {
    return this.flows.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.flows.remove(id);
  }

  @Post(':id/steps')
  addStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateStepDto,
  ): Promise<FlowDetail> {
    return this.flows.addStep(id, dto);
  }

  @Patch(':id/steps/:stepId')
  updateStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: UpdateStepDto,
  ): Promise<FlowDetail> {
    return this.flows.updateStep(id, stepId, dto);
  }

  @Delete(':id/steps/:stepId')
  removeStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
  ): Promise<FlowDetail> {
    return this.flows.removeStep(id, stepId);
  }

  @Post(':id/steps/reorder')
  reorderSteps(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderStepsDto,
  ): Promise<FlowDetail> {
    return this.flows.reorderSteps(id, dto);
  }
}
