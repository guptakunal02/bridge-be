import { ChannelType } from '../database/enums';

/**
 * Static registry of every ticket attribute that a routing rule can
 * key off. Code-only — adding a new attribute is a code change (new
 * key + evaluator + FE listing), not a data change. This keeps the
 * evaluator honest: no unbounded set of keys, no runtime schema drift.
 *
 * Each attribute declares its value type + allowed operators, and
 * the FE reads this list via GET /rules/attributes to build the
 * condition builder dropdowns.
 */

export type AttributeType = 'integer' | 'enum' | 'string' | 'string_array';

export type Operator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'contains_any';

export interface AttributeDefinition {
  key: string;
  label: string;
  description: string;
  type: AttributeType;
  operators: Operator[];
  /** For type='enum' — the allowed values. */
  enumValues?: readonly string[];
  /** For type='integer' — soft bounds the FE uses for input constraints. */
  min?: number;
  max?: number;
}

const INT_OPS: Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const ENUM_OPS: Operator[] = ['eq', 'neq'];
const STRING_OPS: Operator[] = [
  'eq',
  'neq',
  'contains',
  'starts_with',
  'ends_with',
];
const STRING_ARRAY_OPS: Operator[] = [
  'contains',
  'not_contains',
  'contains_any',
];

export const ATTRIBUTES: readonly AttributeDefinition[] = [
  {
    key: 'created_at.hour_ist',
    label: 'Created at (hour, IST)',
    description:
      'Hour of the day (0-23) when the ticket landed, in IST. Use two conditions ORed together for OOH-style time windows.',
    type: 'integer',
    operators: INT_OPS,
    min: 0,
    max: 23,
  },
  {
    key: 'created_at.dow',
    label: 'Created on (day of week)',
    description:
      'Day of week when the ticket landed, in IST. 0 = Sunday, 6 = Saturday.',
    type: 'integer',
    operators: INT_OPS,
    min: 0,
    max: 6,
  },
  {
    key: 'channel_type',
    label: 'Channel',
    description: 'Which channel produced the ticket.',
    type: 'enum',
    enumValues: Object.values(ChannelType),
    operators: ENUM_OPS,
  },
  {
    key: 'sender_email',
    label: 'Sender email',
    description:
      "Address of the person who opened the thread. Matches on the ticket's first inbound message.",
    type: 'string',
    operators: STRING_OPS,
  },
  {
    key: 'subject',
    label: 'Subject',
    description:
      "Subject line of the ticket's first inbound message (empty string if none).",
    type: 'string',
    operators: STRING_OPS,
  },
  {
    key: 'tags',
    label: 'Tags',
    description:
      'Free-form labels on the ticket. `contains` matches when the given value is one of the tags; `contains_any` matches when any of a list of values is present.',
    type: 'string_array',
    operators: STRING_ARRAY_OPS,
  },
] as const;

const BY_KEY = new Map(ATTRIBUTES.map((a) => [a.key, a]));

export function findAttribute(key: string): AttributeDefinition | undefined {
  return BY_KEY.get(key);
}
