import { ChannelType } from '../database/enums';
import type { TicketContext } from './rule-evaluator.service';

/**
 * Raw inputs the rule engine sees. Not a ticket entity — this is the
 * pre-persist snapshot the ingest path assembles right before it
 * decides which team to route to.
 */
export interface IngestFacts {
  createdAt: Date;
  channelType: ChannelType;
  senderEmail: string | null;
  subject: string | null;
  tags: string[];
}

/**
 * Extract every registered attribute value from an IngestFacts
 * snapshot. IST is baked in via Intl (not tz-libraries) so we don't
 * take a dep just for the offset — the value shape (hour 0-23, dow
 * 0-6) matches what the FE picker sends.
 */
export function buildTicketContext(facts: IngestFacts): TicketContext {
  const ist = getIstParts(facts.createdAt);
  return {
    'created_at.hour_ist': ist.hour,
    'created_at.dow': ist.dow,
    channel_type: facts.channelType,
    sender_email: facts.senderEmail ?? '',
    subject: facts.subject ?? '',
    tags: facts.tags,
  };
}

interface IstParts {
  hour: number;
  dow: number;
}

/**
 * Compute (hour, day-of-week) as observed in Asia/Kolkata using the
 * platform Intl formatter — same source the DB queries use via
 * `AT TIME ZONE 'Asia/Kolkata'`, so the two agree on what "9am IST"
 * means.
 */
function getIstParts(d: Date): IstParts {
  // en-US 'hour: 2-digit' with hour12: false yields "00".."23".
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false,
  }).format(d);
  // Intl quirk: some ICU builds render midnight as "24". Fold it.
  const hour = Number(hourStr) % 24;

  // 'weekday: short' gives "Sun"..."Sat"; map to 0..6.
  const wk = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(d);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk);

  return { hour, dow };
}
