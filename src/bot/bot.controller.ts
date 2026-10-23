import { Controller, Get, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../database/enums';
import {
  BotActivityLog,
  type BotActivityEvent,
} from './entities/bot-activity-log.entity';
import { BotFunctionResponse } from './functions/dto/function-response.dto';
import { BotFunctionsService } from './functions/bot-functions.service';

export interface BotActivityRowResponse {
  id: string;
  sessionId: string;
  ticketId: string;
  flowId: string;
  stepId: string | null;
  event: BotActivityEvent;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * ADMIN-only surface. Everything under /bot mutates routing/behaviour,
 * which affects every conversation.
 *
 * MVP endpoint set — flow CRUD lands in the next task.
 */
@Controller('bot')
@Roles(UserRole.ADMIN)
export class BotController {
  constructor(
    private readonly functions: BotFunctionsService,
    @InjectRepository(BotActivityLog)
    private readonly activity: Repository<BotActivityLog>,
  ) {}

  /**
   * Catalog for the flow builder's "Call function" step dropdown.
   * Returns metadata only — the actual handler bodies stay on the
   * server.
   */
  @Get('functions')
  listFunctions(): BotFunctionResponse[] {
    return this.functions.list();
  }

  /**
   * Full bot_activity_log timeline for a single ticket, oldest first.
   * Powers the admin-only "Bot" tab on the ticket sidebar — replays
   * step entry, option matches, payload-routed jumps, late-tap
   * recoveries, unknown replies, and session terminal events so an
   * admin can debug "why did the bot do X" without SSHing into the DB.
   *
   * Returns [] for tickets that never engaged the bot — same shape
   * as a quiet one, so the FE doesn't branch.
   */
  @Get('activity/:ticketId')
  async getActivity(
    @Param('ticketId') ticketId: string,
  ): Promise<BotActivityRowResponse[]> {
    const rows = await this.activity.find({
      where: { ticket_id: ticketId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      ticketId: r.ticket_id,
      flowId: r.flow_id,
      stepId: r.step_id,
      event: r.event,
      message: r.message,
      payload: r.payload ?? {},
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
