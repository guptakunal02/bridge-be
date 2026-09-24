import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../database/enums';
import { AppSettingsService } from './app-settings.service';
import {
  GeneralSettingsResponse,
  UpdateGeneralSettingsDto,
} from './dto/general-settings.dto';

/**
 * Workspace-wide knobs. Reads are open to every authenticated user
 * (the FE surfaces some values contextually — e.g. showing the
 * reopen window when explaining ticket behaviour). Writes are
 * admin-only.
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: AppSettingsService) {}

  @Get('general')
  async getGeneral(): Promise<GeneralSettingsResponse> {
    const resolvedReopenWindowHours =
      await this.settings.getResolvedReopenWindowHours();
    return { resolvedReopenWindowHours };
  }

  @Patch('general')
  @Roles(UserRole.ADMIN)
  async updateGeneral(
    @Body() dto: UpdateGeneralSettingsDto,
  ): Promise<GeneralSettingsResponse> {
    if (dto.resolvedReopenWindowHours !== undefined) {
      await this.settings.setResolvedReopenWindowHours(
        dto.resolvedReopenWindowHours,
      );
    }
    return this.getGeneral();
  }
}
