import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { EmailTemplateCategory } from '../database/enums';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import {
  toEmailTemplateResponse,
  type EmailTemplateResponse,
} from './dto/email-template-response.dto';
import { TestSendEmailTemplateDto } from './dto/test-send-email-template.dto';
import { EmailTemplatesService } from './email-templates.service';

/**
 * HTTP surface for email templates. Routes mirror the WhatsApp
 * templates controller so the FE API layer can stay symmetrical.
 * Any authenticated member can list/create — "global templates"
 * mirror the WhatsApp policy. Add @Roles(UserRole.ADMIN) later if
 * needed.
 */
@Controller('channels/:channelId/email-templates')
export class EmailTemplatesController {
  constructor(private readonly templates: EmailTemplatesService) {}

  @Get()
  async list(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query('category') categoryRaw?: string,
  ): Promise<EmailTemplateResponse[]> {
    const category = this.parseCategory(categoryRaw);
    const rows = await this.templates.list(channelId, { category });
    return rows.map(toEmailTemplateResponse);
  }

  @Get('by-number/:n')
  async byNumber(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('n') nParam: string,
  ): Promise<EmailTemplateResponse> {
    const n = Number(nParam);
    if (!Number.isInteger(n) || n <= 0) {
      throw new NotFoundException('Template not found');
    }
    const row = await this.templates.findByNumber(channelId, n);
    return toEmailTemplateResponse(row);
  }

  @Post()
  async create(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEmailTemplateDto,
  ): Promise<EmailTemplateResponse> {
    const row = await this.templates.create(channelId, user.id, dto);
    return toEmailTemplateResponse(row);
  }

  @Post(':templateId/test')
  @HttpCode(HttpStatus.OK)
  async testSend(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TestSendEmailTemplateDto,
  ): Promise<{ externalMessageId: string }> {
    return this.templates.testSend(
      templateId,
      channelId,
      user.id,
      dto.recipientEmail,
      dto.variableOverrides ?? {},
    );
  }

  private parseCategory(raw?: string): EmailTemplateCategory | undefined {
    if (!raw) return undefined;
    const upper = raw.toUpperCase();
    const options = Object.values(EmailTemplateCategory) as string[];
    if (!options.includes(upper)) return undefined;
    return upper as EmailTemplateCategory;
  }
}
