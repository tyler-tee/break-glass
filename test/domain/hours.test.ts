import { describe, it, expect } from 'vitest';
import { describeHours, hoursProfile, isOpenNow, normalizeHours } from '../../src/domain/hours.js';
import type { WeeklyHours } from '../../src/domain/types.js';

const TZ = 'America/Denver';
const empty = { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] };
const hoursWith = (periods: Partial<WeeklyHours['periods']>): WeeklyHours => ({
  periods: { ...empty, ...periods },
  weekdayText: [],
});

describe('normalizeHours', () => {
  it('returns null for undefined or empty input', () => {
    expect(normalizeHours(undefined)).toBeNull();
    expect(normalizeHours([])).toBeNull();
  });

  it('fills every day, sorts by open, and handles overnight and 24h periods', () => {
    const h = normalizeHours([
      { open: { day: 1, hour: 13, minute: 0 }, close: { day: 1, hour: 17, minute: 30 } },
      { open: { day: 1, hour: 8, minute: 5 }, close: { day: 1, hour: 12, minute: 0 } },
      { open: { day: 5, hour: 20, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
      { open: { day: 3, hour: 0, minute: 0 } },
    ]);
    expect(h).not.toBeNull();
    expect(Object.keys(h!.periods)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(h!.periods['1']).toEqual([
      { open: '0805', close: '1200' },
      { open: '1300', close: '1730' },
    ]);
    expect(h!.periods['5']).toEqual([{ open: '2000', close: '0200' }]);
    expect(h!.periods['3']).toEqual([{ open: '0000', close: '2400' }]);
    expect(h!.periods['0']).toEqual([]);
    expect(h!.weekdayText).toEqual([]);
  });
});

describe('normalizeHours 24/7', () => {
  it('lone no-close period at Sunday 00:00 means open 24/7', () => {
    const h = normalizeHours([{ open: { day: 0, hour: 0, minute: 0 } }]);
    expect(h).not.toBeNull();
    for (const d of ['0', '1', '2', '3', '4', '5', '6'] as const) {
      expect(h!.periods[d]).toEqual([{ open: '0000', close: '2400' }]);
    }
    // Wed 2026-10-28 15:00 Denver (UTC-6) = 21:00Z
    expect(isOpenNow(h, new Date('2026-10-28T21:00:00Z'), TZ)).toEqual({ state: 'open', until: '2400' });
  });
});

describe('isOpenNow', () => {
  it('null hours → unknown', () =>
    expect(isOpenNow(null, new Date(), TZ).state).toBe('unknown'));

  it('open inside a daytime interval', () => {
    // Tue 2026-10-27 10:00 Denver (UTC-6) = 16:00Z
    const h = hoursWith({ '2': [{ open: '0800', close: '1700' }] });
    expect(isOpenNow(h, new Date('2026-10-27T16:00:00Z'), TZ)).toEqual({ state: 'open', until: '1700' });
  });

  it('overnight interval spills into next day', () => {
    // Sat 2026-10-31 01:00 Denver = 07:00Z; Fri 2000-0200
    const h = hoursWith({ '5': [{ open: '2000', close: '0200' }] });
    expect(isOpenNow(h, new Date('2026-10-31T07:00:00Z'), TZ)).toEqual({ state: 'open', until: '0200' });
  });

  it('closed day', () => {
    // Tue 10:00 Denver, only Monday has hours
    const h = hoursWith({ '1': [{ open: '0800', close: '1700' }] });
    expect(isOpenNow(h, new Date('2026-10-27T16:00:00Z'), TZ).state).toBe('closed');
  });

  it('tz boundary: 23:30 Denver is next day in UTC and still Tuesday locally', () => {
    // 2026-10-28T05:30Z is Wed in UTC but Tue 23:30 in Denver
    const h = hoursWith({ '2': [{ open: '1800', close: '2359' }] });
    expect(isOpenNow(h, new Date('2026-10-28T05:30:00Z'), TZ)).toEqual({ state: 'open', until: '2359' });
    const wedOnly = hoursWith({ '3': [{ open: '0000', close: '2400' }] });
    expect(isOpenNow(wedOnly, new Date('2026-10-28T05:30:00Z'), TZ).state).toBe('closed');
  });
});

describe('describeHours', () => {
  const NY = 'America/New_York';
  // 2026-10-31 is a Saturday; 18:00Z is 2:00 PM in New York.
  const SAT_2PM = new Date('2026-10-31T18:00:00Z');
  const weekdays = (open: string, close: string, days = ['1', '2', '3', '4', '5']) =>
    hoursWith(Object.fromEntries(days.map((d) => [d, [{ open, close }]])));

  it('unknown without hours or with an empty week', () => {
    expect(describeHours(null, SAT_2PM, NY)).toEqual({ state: 'unknown' });
    expect(describeHours(hoursWith({}), SAT_2PM, NY)).toEqual({ state: 'unknown' });
  });

  it('every day midnight to midnight reads as open 24 hours', () => {
    const all = weekdays('0000', '2400', ['0', '1', '2', '3', '4', '5', '6']);
    expect(describeHours(all, SAT_2PM, NY)).toEqual({ state: 'open', label: 'open 24 hours' });
  });

  it('open today says until the closing time, without minutes when on the hour', () => {
    expect(describeHours(weekdays('0800', '2100', ['6']), SAT_2PM, NY)).toEqual({ state: 'open', label: 'until 9 PM' });
    expect(describeHours(weekdays('0800', '1730', ['6']), SAT_2PM, NY)).toEqual({ state: 'open', label: 'until 5:30 PM' });
  });

  it('closed says when it next opens, naming the day only when a day or more away', () => {
    expect(describeHours(weekdays('0730', '1600'), SAT_2PM, NY)).toEqual({ state: 'closed', label: 'opens Mon 7:30 AM' });
    expect(describeHours(weekdays('1800', '2200', ['6']), SAT_2PM, NY)).toEqual({ state: 'closed', label: 'opens 6 PM' });
    expect(describeHours(weekdays('0900', '1200', ['0']), SAT_2PM, NY)).toEqual({ state: 'closed', label: 'opens 9 AM' });
  });

  it('overnight spans run into the next day, and a short nightly break is not 24 hours', () => {
    // Open 2:00 AM until 1:30 AM the next day, every day (a pharmacy with a 30-minute break).
    const nightly = weekdays('0200', '0130', ['0', '1', '2', '3', '4', '5', '6']);
    expect(describeHours(nightly, SAT_2PM, NY)).toEqual({ state: 'open', label: 'until 1:30 AM' });
    const inBreak = new Date('2026-10-31T05:45:00Z'); // Sat 1:45 AM
    expect(describeHours(nightly, inBreak, NY)).toEqual({ state: 'closed', label: 'opens 2 AM' });
  });

  it('a Saturday-night span wraps into Sunday', () => {
    const late = hoursWith({ '6': [{ open: '2000', close: '0200' }] });
    const sunOneAm = new Date('2026-11-01T05:00:00Z'); // Sun 1:00 AM EDT
    expect(describeHours(late, sunOneAm, NY)).toEqual({ state: 'open', label: 'until 2 AM' });
  });

  it('uses the home time zone, not the server one', () => {
    const h = weekdays('0800', '2100', ['6']);
    // The same instant is Sat 10:30 PM in New York (closed) but Sat 7:30 PM in Los Angeles (open).
    expect(describeHours(h, new Date('2026-11-01T02:30:00Z'), NY)).toEqual({ state: 'closed', label: 'opens Sat 8 AM' });
    expect(describeHours(h, new Date('2026-11-01T02:30:00Z'), 'America/Los_Angeles')).toEqual({ state: 'open', label: 'until 9 PM' });
  });
});

describe('hoursProfile', () => {
  const every = (open: string, close: string) => {
    const iv = () => [{ open, close }];
    return hoursWith({ '0': iv(), '1': iv(), '2': iv(), '3': iv(), '4': iv(), '5': iv(), '6': iv() });
  };

  it('24/7 is "24 hours" with no gap note', () => {
    const p = hoursProfile(normalizeHours([{ open: { day: 0, hour: 0, minute: 0 } }]));
    expect(p).toEqual({ open24h: true, summary: '24 hours', eveningsOrWeekends: true });
  });

  it('2 PM to 1:30 PM every day is 24 hours with a daily pharmacist break', () => {
    const p = hoursProfile(every('1400', '1330'));
    expect(p).toMatchObject({ open24h: true, summary: '24 hours', dailyGapNote: 'Closed 1:30–2 PM daily' });
  });

  it('2 AM to 1:30 AM every day notes the night-time break', () => {
    expect(hoursProfile(every('0200', '0130'))).toMatchObject({ open24h: true, dailyGapNote: 'Closed 1:30–2 AM daily' });
  });

  it('a split day closed overnight is not 24 hours but counts as evenings', () => {
    const iv = () => [
      { open: '0800', close: '1330' },
      { open: '1400', close: '0000' },
    ];
    const p = hoursProfile(hoursWith({ '0': iv(), '1': iv(), '2': iv(), '3': iv(), '4': iv(), '5': iv(), '6': iv() }));
    expect(p.open24h).toBe(false);
    expect(p.eveningsOrWeekends).toBe(true);
    expect(p.summary).toBe('Daily 8 AM – 1:30 PM, 2 PM – midnight');
  });

  it('7 AM to 11 PM every day is not 24 hours', () => {
    expect(hoursProfile(every('0700', '2300'))).toEqual({
      open24h: false,
      summary: 'Daily 7 AM – 11 PM',
      eveningsOrWeekends: true,
    });
  });

  it('Mon–Fri 8 to 5 is "Weekdays" and not evenings or weekends', () => {
    const iv = () => [{ open: '0800', close: '1700' }];
    expect(hoursProfile(hoursWith({ '1': iv(), '2': iv(), '3': iv(), '4': iv(), '5': iv() }))).toEqual({
      open24h: false,
      summary: 'Weekdays 8 AM – 5 PM',
      eveningsOrWeekends: false,
    });
  });

  it('10 AM to 8 PM every day is "Daily" and counts as evenings', () => {
    expect(hoursProfile(every('1000', '2000'))).toEqual({
      open24h: false,
      summary: 'Daily 10 AM – 8 PM',
      eveningsOrWeekends: true,
    });
  });

  it('null or empty hours are unknown', () => {
    const unknown = { open24h: false, summary: 'Hours unknown', eveningsOrWeekends: false };
    expect(hoursProfile(null)).toEqual(unknown);
    expect(hoursProfile(hoursWith({}))).toEqual(unknown);
  });

  it('one 24-hour Monday is not open 24 hours', () => {
    const p = hoursProfile(hoursWith({ '1': [{ open: '0000', close: '0000' }] }));
    expect(p.open24h).toBe(false);
    expect(p.summary).toBe('Varies by day');
  });

  it('a Saturday-only morning counts as weekends', () => {
    const iv = () => [{ open: '0900', close: '1700' }];
    const p = hoursProfile(hoursWith({ '1': iv(), '2': iv(), '3': iv(), '4': iv(), '5': iv(), '6': [{ open: '0900', close: '1200' }] }));
    expect(p).toEqual({ open24h: false, summary: 'Varies by day', eveningsOrWeekends: true });
  });
});
