import type { Interval, WeeklyHours } from './types.js';

type PlacesPoint = { day: number; hour: number; minute: number };
export type PlacesPeriod = { open: PlacesPoint; close?: PlacesPoint };

type DayKey = keyof WeeklyHours['periods'];

const hhmm = (p: PlacesPoint): string =>
  `${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}`;

export function normalizeHours(
  periods: PlacesPeriod[] | undefined,
  weekdayText: string[] = [],
): WeeklyHours | null {
  if (!periods || periods.length === 0) return null;
  const only = periods.length === 1 ? periods[0] : undefined;
  if (only && !only.close && only.open.day === 0 && only.open.hour === 0 && only.open.minute === 0) {
    // Places encodes a 24/7 location as one no-close period at Sunday 00:00.
    const always = (): Interval[] => [{ open: '0000', close: '2400' }];
    return {
      periods: { '0': always(), '1': always(), '2': always(), '3': always(), '4': always(), '5': always(), '6': always() },
      weekdayText,
    };
  }
  const out: WeeklyHours['periods'] = { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] };
  for (const p of periods) {
    const interval: Interval = p.close
      ? { open: hhmm(p.open), close: hhmm(p.close) }
      : { open: '0000', close: '2400' };
    out[String(p.open.day) as DayKey].push(interval);
  }
  for (const key of Object.keys(out) as DayKey[]) {
    out[key].sort((a, b) => a.open.localeCompare(b.open));
  }
  return { periods: out, weekdayText };
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isOpenNow(
  hours: WeeklyHours | null,
  now: Date,
  tz: string,
): { state: 'open' | 'closed' | 'unknown'; until?: string } {
  if (!hours) return { state: 'unknown' };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = WEEKDAYS[get('weekday')];
  const t = Number(get('hour') + get('minute'));

  for (const iv of hours.periods[String(day) as DayKey]) {
    const open = Number(iv.open);
    let close = Number(iv.close);
    if (close < open) close += 2400;
    if (open <= t && t < close) return { state: 'open', until: iv.close };
  }
  for (const iv of hours.periods[String((day + 6) % 7) as DayKey]) {
    if (Number(iv.close) < Number(iv.open) && t < Number(iv.close)) {
      return { state: 'open', until: iv.close };
    }
  }
  return { state: 'closed' };
}
