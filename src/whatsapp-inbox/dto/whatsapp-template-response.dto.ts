import {
  WhatsappTemplateCategory,
  WhatsappTemplateHeaderType,
  WhatsappTemplateStatus,
} from '../../database/enums';
import { WhatsappTemplate } from '../entities/whatsapp-template.entity';
import type { WhatsappTemplateButton } from '../template-buttons';
import type { VariableMappingEntry } from '../template-variables';

export interface WhatsappTemplateResponse {
  id: string;
  /**
   * Short integer identifier (e.g. 4) used in Outreach URLs + the
   * composer slash picker. Stringified at the DTO boundary since
   * bigint doesn't survive JSON safely for very large values.
   */
  number: number;
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
  /**
   * Named-variable mapping — null for templates synced from Meta BM
   * (which only carry positional {{1}}, {{2}} bodies). The composer's
   * slash picker renders a LEGACY badge for null-mapping rows and
   * falls back to the positional "fill {{1}} manually" UX.
   */
  variableMapping: VariableMappingEntry[] | null;
  /** Phase 2a visual-rich fields. All default-neutral on legacy rows. */
  headerType: WhatsappTemplateHeaderType;
  headerText: string | null;
  headerMediaUrl: string | null;
  footerText: string | null;
  buttons: WhatsappTemplateButton[] | null;
  createdAt: string;
  updatedAt: string;
}

export function toTemplateResponse(
  t: WhatsappTemplate,
): WhatsappTemplateResponse {
  return {
    id: t.id,
    number: Number(t.number),
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
    variableMapping: t.variableMapping,
    // headerMediaHandle intentionally excluded — it's a Meta-internal
    // identifier of no use to the FE; `headerMediaUrl` is what the
    // preview + send-time image.link reads.
    headerType: t.headerType,
    headerText: t.headerText,
    headerMediaUrl: t.headerMediaUrl,
    footerText: t.footerText,
    buttons: t.buttons,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
