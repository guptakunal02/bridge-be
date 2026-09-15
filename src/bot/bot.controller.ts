import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../database/enums';
import { BotFunctionResponse } from './functions/dto/function-response.dto';
import { BotFunctionsService } from './functions/bot-functions.service';

/**
 * ADMIN-only surface. Everything under /bot mutates routing/behaviour,
 * which affects every conversation.
 *
 * MVP endpoint set — flow CRUD lands in the next task.
 */
@Controller('bot')
@Roles(UserRole.ADMIN)
export class BotController {
  constructor(private readonly functions: BotFunctionsService) {}

  /**
   * Catalog for the flow builder's "Call function" step dropdown.
   * Returns metadata only — the actual handler bodies stay on the
   * server.
   */
  @Get('functions')
  listFunctions(): BotFunctionResponse[] {
    return this.functions.list();
  }
}
