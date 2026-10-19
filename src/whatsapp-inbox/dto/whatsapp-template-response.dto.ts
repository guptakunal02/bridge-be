import {
  WhatsappTemplateCategory,
  WhatsappTemplateStatus,
} from '../../database/enums';
import { WhatsappTemplate } from '../entities/whatsapp-template.entity';

export interface WhatsappTemplateResponse {
  id: string;
  channelId: string;
  name: string;
  category: WhatsappTemplateCategory;
  language: string;
  body: string;
  variableCount: number;
  status: WhatsappTemplateStatus;
  rejectionReason: string | null;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toTemplateResponse(
  t: WhatsappTemplate,
): WhatsappTemplateResponse {
  return {
    id: t.id,
    channelId: t.channelId,
    name: t.name,
    category: t.category,
    language: t.language,
    body: t.body,
    variableCount: t.variableCount,
    status: t.status,
    rejectionReason: t.rejectionReason,
    createdBy: t.createdBy,
    creatorName: t.creator?.name ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
