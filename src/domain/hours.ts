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
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;

function localDayTime(now: Date, tz: string): { day: number; hhmm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: WEEKDAYS[get('weekday')]!, hhmm: Number(get('hour') + get('minute')) };
}

export function isOpenNow(
  hours: WeeklyHours | null,
  now: Date,
  tz: string,
): { state: 'open' | 'closed' | 'unknown'; until?: string } {
  if (!hours) return { state: 'unknown' };
  const { day, hhmm: t } = localDayTime(now, tz);

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

export type HoursStatus =
  | { state: 'open'; label: string }
  | { state: 'closed'; label: string }
  | { state: 'unknown' };

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4));

/** "9 PM", "7:30 AM", "midnight". Takes minutes since local midnight. */
export function formatClock(minuteOfDay: number): string {
  const m = ((minuteOfDay % DAY_MIN) + DAY_MIN) % DAY_MIN;
  if (m === 0) return 'midnight';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// The week as merged [start, end) spans in minutes from Sunday 00:00. Overnight spans run past the
// day boundary, and a span may run past the end of the week (it then wraps to Sunday).
function weekSpans(hours: WeeklyHours): [number, number][] {
  const spans: [number, number][] = [];
  for (let d = 0; d < 7; d++) {
    for (const iv of hours.periods[String(d) as DayKey]) {
      const open = toMin(iv.open);
      let close = toMin(iv.close);
      if (close <= open) close += DAY_MIN;
      spans.push([d * DAY_MIN + open, d * DAY_MIN + close]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  // A span that wraps past Saturday night can join the first span of Sunday.
  const first = merged[0];
  const last = merged[merged.length - 1];
  if (merged.length > 1 && first && last && last[1] - WEEK_MIN >= first[0]) {
    last[1] = Math.max(last[1], first[1] + WEEK_MIN);
    merged.shift();
  }
  return merged;
}

/**
 * What the family sees next to the open/closed pill: "open 24 hours", "until 9 PM",
 * "opens 8 AM", "opens Mon 7:30 AM". A day name appears only when the time is 24 hours or more away.
 */
export function describeHours(hours: WeeklyHours | null, now: Date, tz: string): HoursStatus {
  if (!hours) return { state: 'unknown' };
  const spans = weekSpans(hours);
  if (spans.length === 0) return { state: 'unknown' };
  if (spans.some(([s, e]) => e - s >= WEEK_MIN)) return { state: 'open', label: 'open 24 hours' };

  const { day, hhmm } = localDayTime(now, tz);
  const t = day * DAY_MIN + Math.floor(hhmm / 100) * 60 + (hhmm % 100);
  const at = (abs: number) => {
    const delta = (((abs - t) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
    const time = formatClock(abs);
    return delta >= DAY_MIN ? `${DAY_NAMES[Math.floor((abs % WEEK_MIN) / DAY_MIN)]} ${time}` : time;
  };

  for (const [s, e] of spans) {
    if ((s <= t && t < e) || (s <= t + WEEK_MIN && t + WEEK_MIN < e)) return { state: 'open', label: `until ${at(e)}` };
  }
  const next = spans.find(([s]) => s > t) ?? spans[0]!;
  return { state: 'closed', label: `opens ${at(next[0])}` };
}
