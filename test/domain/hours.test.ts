import { describe, it, expect } from 'vitest';
import { isOpenNow, normalizeHours } from '../../src/domain/hours.js';
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
