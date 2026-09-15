import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { BotFlow } from '../entities/bot-flow.entity';
import { BotStep } from '../entities/bot-step.entity';
import type { CreateFlowDto } from './dto/create-flow.dto';
import {
  FlowDetail,
  FlowResponse,
  toFlowDetail,
  toFlowResponse,
} from './dto/flow-response.dto';
import type {
  CreateStepDto,
  ReorderStepsDto,
  UpdateStepDto,
} from './dto/step.dto';
import type { UpdateFlowDto } from './dto/update-flow.dto';
import { StepConfigValidator } from './step-config-validator.service';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class FlowsService {
  constructor(
    @InjectRepository(BotFlow)
    private readonly flows: Repository<BotFlow>,
    @InjectRepository(BotStep)
    private readonly steps: Repository<BotStep>,
    private readonly configValidator: StepConfigValidator,
    private readonly dataSource: DataSource,
  ) {}

  async list(): Promise<FlowResponse[]> {
    const rows = await this.flows.find({
      order: { createdAt: 'ASC' },
    });
    if (rows.length === 0) return [];
    const counts = await this.steps
      .createQueryBuilder('s')
      .select('s.flow_id', 'flow_id')
      .addSelect('COUNT(*)', 'count')
      .where('s.flow_id IN (:...ids)', { ids: rows.map((f) => f.id) })
      .groupBy('s.flow_id')
      .getRawMany<{ flow_id: string; count: string }>();
    const byId = new Map(counts.map((c) => [c.flow_id, Number(c.count)]));
    return rows.map((f) => toFlowResponse(f, byId.get(f.id) ?? 0));
  }

  async get(id: string): Promise<FlowDetail> {
    const flow = await this.flows.findOne({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    const steps = await this.steps.find({
      where: { flow_id: id },
      order: { position: 'ASC' },
    });
    return toFlowDetail(flow, steps);
  }

  async create(dto: CreateFlowDto): Promise<FlowResponse> {
    this.configValidator.validateTriggerConditions(dto.triggerConditions);
    try {
      const created = await this.flows.save(
        this.flows.create({
          name: dto.name,
          description: dto.description ?? null,
          trigger: dto.trigger,
          trigger_conditions: dto.triggerConditions ?? null,
          is_active: dto.isActive ?? true,
          first_step_id: null,
        }),
      );
      return toFlowResponse(created, 0);
    } catch (err) {
      throw translateUniqueError(err);
    }
  }

  async update(id: string, dto: UpdateFlowDto): Promise<FlowResponse> {
    const flow = await this.flows.findOne({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');

    const patch: Partial<BotFlow> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.trigger !== undefined) patch.trigger = dto.trigger;
    if (dto.triggerConditions !== undefined) {
      this.configValidator.validateTriggerConditions(dto.triggerConditions);
      (patch as { trigger_conditions?: unknown }).trigger_conditions =
        dto.triggerConditions;
    }
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;
    if (dto.firstStepId !== undefined) {
      // Verify the step actually belongs to this flow.
      const step = await this.steps.findOne({
        where: { id: dto.firstStepId, flow_id: id },
      });
      if (!step) {
        throw new BadRequestException(
          'firstStepId must reference a step that belongs to this flow',
        );
      }
      patch.first_step_id = dto.firstStepId;
    }

    if (Object.keys(patch).length > 0) {
      try {
        await this.flows.update(
          { id },
          patch as unknown as Parameters<typeof this.flows.update>[1],
        );
      } catch (err) {
        throw translateUniqueError(err);
      }
    }
    const stepCount = await this.steps.count({ where: { flow_id: id } });
    const updated = await this.flows.findOneOrFail({ where: { id } });
    return toFlowResponse(updated, stepCount);
  }

  async remove(id: string): Promise<void> {
    const result = await this.flows.delete({ id });
    if (!result.affected) throw new NotFoundException('Flow not found');
  }

  /**
   * Append a new step. Position = current-step-count so drag-reorder
   * can shuffle without ever leaving a gap. When the flow has no
   * first_step_id yet, auto-set this step as the entry point — the
   * common "I just created a flow, this is the first step" shortcut.
   */
  async addStep(flowId: string, dto: CreateStepDto): Promise<FlowDetail> {
    const flow = await this.flows.findOne({ where: { id: flowId } });
    if (!flow) throw new NotFoundException('Flow not found');

    this.configValidator.validate(dto.type, dto.config ?? {});

    return this.dataSource.transaction(async (mgr) => {
      const stepRepo = mgr.getRepository(BotStep);
      const flowRepo = mgr.getRepository(BotFlow);

      const position = await stepRepo.count({ where: { flow_id: flowId } });
      const created = await stepRepo.save(
        stepRepo.create({
          flow_id: flowId,
          position,
          type: dto.type,
          // Cast around the `unknown` type on the jsonb column.
          config: dto.config ?? {},
        }),
      );

      if (flow.first_step_id === null) {
        await flowRepo.update({ id: flowId }, { first_step_id: created.id });
      }

      const flowAfter = await flowRepo.findOneOrFail({ where: { id: flowId } });
      const stepsAfter = await stepRepo.find({
        where: { flow_id: flowId },
        order: { position: 'ASC' },
      });
      return toFlowDetail(flowAfter, stepsAfter);
    });
  }

  async updateStep(
    flowId: string,
    stepId: string,
    dto: UpdateStepDto,
  ): Promise<FlowDetail> {
    const step = await this.steps.findOne({
      where: { id: stepId, flow_id: flowId },
    });
    if (!step) throw new NotFoundException('Step not found');

    const nextType = dto.type ?? step.type;
    const nextConfig =
      dto.config !== undefined
        ? dto.config
        : (step.config as Record<string, unknown>);
    this.configValidator.validate(nextType, nextConfig);

    const patch: Partial<BotStep> = {};
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.config !== undefined) {
      (patch as { config?: unknown }).config = dto.config;
    }

    if (Object.keys(patch).length > 0) {
      await this.steps.update(
        { id: stepId },
        patch as unknown as Parameters<typeof this.steps.update>[1],
      );
    }
    return this.get(flowId);
  }

  async removeStep(flowId: string, stepId: string): Promise<FlowDetail> {
    return this.dataSource.transaction(async (mgr) => {
      const stepRepo = mgr.getRepository(BotStep);
      const flowRepo = mgr.getRepository(BotFlow);

      const step = await stepRepo.findOne({
        where: { id: stepId, flow_id: flowId },
      });
      if (!step) throw new NotFoundException('Step not found');

      const removedPosition = step.position;
      await stepRepo.delete({ id: stepId });

      // Compact positions so the remaining steps sit at 0..N-1.
      await mgr
        .createQueryBuilder()
        .update(BotStep)
        .set({ position: () => 'position - 1' })
        .where('flow_id = :flowId AND position > :pos', {
          flowId,
          pos: removedPosition,
        })
        .execute();

      // If the deleted step was the entry point, clear it — the
      // admin can pick a new one from the FE.
      const flow = await flowRepo.findOneOrFail({ where: { id: flowId } });
      if (flow.first_step_id === stepId) {
        await flowRepo.update({ id: flowId }, { first_step_id: null });
      }

      const flowAfter = await flowRepo.findOneOrFail({ where: { id: flowId } });
      const stepsAfter = await stepRepo.find({
        where: { flow_id: flowId },
        order: { position: 'ASC' },
      });
      return toFlowDetail(flowAfter, stepsAfter);
    });
  }

  /**
   * Drag-reorder: the client sends the new full ordering of step ids.
   * We refuse anything that doesn't cover the flow's exact set of
   * steps (no dupes, no missing, no foreign ids).
   */
  async reorderSteps(
    flowId: string,
    dto: ReorderStepsDto,
  ): Promise<FlowDetail> {
    const currentSteps = await this.steps.find({
      where: { flow_id: flowId },
      order: { position: 'ASC' },
    });
    const currentIds = new Set(currentSteps.map((s) => s.id));

    if (dto.stepIds.length !== currentIds.size) {
      throw new BadRequestException(
        `Reorder payload has ${dto.stepIds.length} ids; flow has ${currentIds.size} steps`,
      );
    }
    if (new Set(dto.stepIds).size !== dto.stepIds.length) {
      throw new BadRequestException('Reorder payload contains duplicate ids');
    }
    for (const id of dto.stepIds) {
      if (!currentIds.has(id)) {
        throw new BadRequestException(
          `Reorder payload contains unknown step id ${id}`,
        );
      }
    }

    await this.dataSource.transaction(async (mgr) => {
      const stepRepo = mgr.getRepository(BotStep);
      for (let i = 0; i < dto.stepIds.length; i++) {
        await stepRepo.update({ id: dto.stepIds[i] }, { position: i });
      }
    });
    return this.get(flowId);
  }
}

function translateUniqueError(err: unknown): Error {
  if (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
  ) {
    return new ConflictException('A flow with that name already exists.');
  }
  return err as Error;
}
