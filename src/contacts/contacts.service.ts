import { Injectable, NotFoundException } from '@nestjs/common';
import { Contact, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface UpsertContactInput {
  channelId: string;
  externalId: string;
  name?: string | null;
  avatarUrl?: string | null;
  metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  upsertByExternalId(input: UpsertContactInput): Promise<Contact> {
    const { channelId, externalId, name, avatarUrl, metadata } = input;
    return this.prisma.contact.upsert({
      where: { channelId_externalId: { channelId, externalId } },
      update: {
        name: name ?? undefined,
        avatarUrl: avatarUrl ?? undefined,
        metadata: metadata ?? undefined,
      },
      create: {
        channelId,
        externalId,
        name: name ?? null,
        avatarUrl: avatarUrl ?? null,
        metadata: metadata ?? {},
      },
    });
  }

  async getById(id: string): Promise<Contact> {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }
}
