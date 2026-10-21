import {
  EmailTemplateCategory,
  EmailTemplateKind,
} from '../../database/enums';
import { EmailTemplate } from '../entities/email-template.entity';
import type { VariableMappingEntry } from '../../whatsapp-inbox/template-variables';

export interface EmailTemplateResponse {
  id: string;
  number: number;
  channelId: string;
  name: string;
  category: EmailTemplateCategory;
  kind: EmailTemplateKind;
  /** Null for REPLY templates (subject inherited at send time). */
  subject: string | null;
  bodyHtml: string;
  bodyText: string | null;
  variableCount: number;
  variableMapping: VariableMappingEntry[] | null;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toEmailTemplateResponse(
  t: EmailTemplate,
): EmailTemplateResponse {
  return {
    id: t.id,
    number: Number(t.number),
    channelId: t.channelId,
    name: t.name,
    category: t.category,
    kind: t.kind,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    bodyText: t.bodyText,
    variableCount: t.variableCount,
    variableMapping: t.variableMapping,
    createdBy: t.createdBy,
    creatorName: t.creator?.name ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
