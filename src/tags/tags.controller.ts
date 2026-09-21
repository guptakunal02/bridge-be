import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../database/enums';
import { CreateTagDto } from './dto/create-tag.dto';
import { TagResponse, TagsService } from './tags.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  /**
   * Every authenticated user can read the catalogue — the ticket
   * tag editor needs it to render suggestions. Only ADMINs can
   * add or remove entries.
   */
  @Get()
  list(): Promise<TagResponse[]> {
    return this.tags.list();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateTagDto): Promise<TagResponse> {
    return this.tags.create(dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.tags.remove(id);
  }
}
