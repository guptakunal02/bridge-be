import type { BotFunction } from './types';

/**
 * "Are we currently open for business?"
 *
 * Boolean yes/no based on the current wall-clock time in IST. Surma's
 * business hours (as of 2026-10-21): Monday through Saturday,
 * 10:00–18:00 IST. Sundays are closed. Outside the hour range on any
 * open day is closed.
 *
 * Used by the bot to branch between the "we're open, a human will
 * respond" message and the "we're closed, here's an OOH template"
 * flow. No inputs — reads the server clock.
 *
 * IST is a fixed +05:30 offset (no DST), so we can compute it
 * directly off UTC without a tz library — same shortcut
 * computeHourIst / computeDayOfWeekIst use elsewhere in the codebase.
 *
 * Hour-range semantics: 10 ≤ hour < 18. 10:00:00 is in; 18:00:00 is
 * out. "Until 6pm" matches how a shop sign reads.
 */
export const isBusinessHour: BotFunction = {
  key: 'is_business_hour',
  label: 'Is business hour',
  description:
    'True Monday–Saturday 10am–6pm IST. False at all other times (Sundays, nights, early mornings).',
  inputs: [],
  outputs: [
    {
      key: 'isBusinessHour',
      label: 'Is business hour',
      type: 'boolean',
      description:
        'True when Surma is currently open; false during OOH or Sunday.',
    },
  ],
  outcomes: [
    {
      key: 'yes',
      label: 'In business hours',
      description: 'Mon–Sat 10:00–17:59:59 IST.',
    },
    {
      key: 'no',
      label: 'Out of business hours',
      description: 'Sundays, nights, early mornings.',
    },
  ],
  handler: async () => {
    const now = new Date();
    const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    // getUTCDay() on the shifted date gives 0 (Sunday) … 6 (Saturday)
    // as observed in IST.
    const dayOfWeek = ist.getUTCDay();
    const hour = ist.getUTCHours();
    const isOpenDay = dayOfWeek >= 1 && dayOfWeek <= 6; // Mon–Sat
    const isOpenHour = hour >= 10 && hour < 18;
    const open = isOpenDay && isOpenHour;
    return {
      outcome: open ? 'yes' : 'no',
      outputs: { isBusinessHour: open },
    };
  },
};
