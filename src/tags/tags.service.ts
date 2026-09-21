import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import type { CreateTagDto } from './dto/create-tag.dto';
import { Tag } from './entities/tag.entity';

const PG_UNIQUE_VIOLATION = '23505';

export interface TagResponse {
  id: string;
  name: string;
  createdAt: string;
}

@Injectable()
export class TagsService {
  constructor(@InjectRepository(Tag) private readonly tags: Repository<Tag>) {}

  async list(): Promise<TagResponse[]> {
    const rows = await this.tags.find({ order: { name: 'ASC' } });
    return rows.map(toResponse);
  }

  async create(dto: CreateTagDto): Promise<TagResponse> {
    try {
      const saved = await this.tags.save(this.tags.create({ name: dto.name }));
      return toResponse(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A tag named "${dto.name}" already exists.`,
        );
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.tags.delete({ id });
    if (!result.affected) throw new NotFoundException('Tag not found');
  }

  /**
   * Used by TicketsService to validate that every tag on a PATCH
   * belongs to the catalogue. Runs on the same EntityManager as the
   * caller's txn so a tag deleted mid-flight doesn't slip through.
   * Returns the set of names that AREN'T known — caller decides
   * whether to reject the whole PATCH.
   */
  async findUnknownNames(
    names: string[],
    mgr?: EntityManager,
  ): Promise<string[]> {
    if (names.length === 0) return [];
    const repo = mgr ? mgr.getRepository(Tag) : this.tags;
    const rows = await repo
      .createQueryBuilder('t')
      .select('t.name', 'name')
      .where('t.name IN (:...names)', { names })
      .getRawMany<{ name: string }>();
    const known = new Set(rows.map((r) => r.name));
    return names.filter((n) => !known.has(n));
  }
}

function toResponse(t: Tag): TagResponse {
  return {
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
  );
}
