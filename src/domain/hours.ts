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
export function weekSpans(hours: WeeklyHours): [number, number][] {
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

export type HoursProfile = {
  /** Open around the clock, allowing one short daily break (a pharmacist's lunch). */
  open24h: boolean;
  /** "Closed 1:30–2 PM daily": the break an open24h place still takes. */
  dailyGapNote?: string;
  summary: string;
  /** Closes after 6 PM on some day, or opens on a weekend. */
  eveningsOrWeekends: boolean;
};

const MIN_COVERED_24H = 1380;
const MAX_GAP_24H = 60;
const EVENING_MIN = 18 * 60;

/** "1:30–2 PM", "11 PM–1 AM": the meridiem is written once when both ends share it. */
function clockRange(from: number, to: number, sep: string): string {
  const a = formatClock(from);
  const b = formatClock(to);
  const shared = a.slice(-3) === b.slice(-3) && / [AP]M$/.test(a) ? a.slice(0, -3) : a;
  return `${shared}${sep}${b}`;
}

// Closed stretches between merged spans, in absolute minutes; a gap may run past the end of the week.
function weekGaps(spans: [number, number][]): [number, number][] {
  if (spans.length === 0) return [[0, WEEK_MIN]];
  if (spans.some(([s, e]) => e - s >= WEEK_MIN)) return [];
  const gaps: [number, number][] = [];
  spans.forEach(([, end], i) => {
    const next = i + 1 < spans.length ? spans[i + 1]![0] : spans[0]![0] + WEEK_MIN;
    if (next > end) gaps.push([end, next]);
  });
  return gaps;
}

const overlap = (a: [number, number], b: [number, number]): number => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

const sameIntervals = (a: Interval[], b: Interval[]): boolean =>
  a.length === b.length && a.every((iv, i) => iv.open === b[i]!.open && iv.close === b[i]!.close);

const intervalText = (ivs: Interval[]): string =>
  ivs.map((iv) => `${formatClock(toMin(iv.open))} – ${formatClock(toMin(iv.close))}`).join(', ');

/** What ranking needs to know about a weekly schedule: 24 hours or not, a one-line summary, evenings/weekends. */
export function hoursProfile(hours: WeeklyHours | null): HoursProfile {
  const days = hours ? ([0, 1, 2, 3, 4, 5, 6] as const).map((d) => hours.periods[String(d) as DayKey]) : [];
  if (!hours || days.every((ivs) => ivs.length === 0)) {
    return { open24h: false, summary: 'Hours unknown', eveningsOrWeekends: false };
  }

  const gaps = weekGaps(weekSpans(hours));
  let open24h = true;
  for (let d = 0; d < 7; d++) {
    let closed = 0;
    let maxGap = 0;
    for (const g of gaps) {
      // A gap past the end of the week belongs to the start of it, so test both copies of the day.
      const inDay =
        overlap(g, [d * DAY_MIN, (d + 1) * DAY_MIN]) + overlap(g, [d * DAY_MIN + WEEK_MIN, (d + 1) * DAY_MIN + WEEK_MIN]);
      closed += inDay;
      maxGap = Math.max(maxGap, inDay);
    }
    if (DAY_MIN - closed < MIN_COVERED_24H || maxGap > MAX_GAP_24H) open24h = false;
  }

  let dailyGapNote: string | undefined;
  if (open24h && gaps.length > 0) {
    const times = gaps.map(([s, e]) => clockRange(s, e, '–'));
    dailyGapNote = times.every((t) => t === times[0])
      ? `Closed ${times[0]} ${gaps.length === 7 ? 'daily' : 'some days'}`
      : 'Short closures that vary by day';
  }

  const weekdays = days.slice(1, 6);
  let summary: string;
  if (open24h) summary = '24 hours';
  else if (days.every((ivs) => ivs.length > 0 && sameIntervals(ivs, days[0]!))) summary = `Daily ${intervalText(days[0]!)}`;
  else if (
    weekdays.every((ivs) => ivs.length > 0 && sameIntervals(ivs, weekdays[0]!)) &&
    days[0]!.length === 0 &&
    days[6]!.length === 0
  ) {
    summary = `Weekdays ${intervalText(weekdays[0]!)}`;
  } else summary = 'Varies by day';

  const lateClose = days.some((ivs) =>
    ivs.some((iv) => {
      const open = toMin(iv.open);
      const close = toMin(iv.close);
      return close <= open || close > EVENING_MIN;
    }),
  );
  const weekend = days[0]!.length > 0 || days[6]!.length > 0;

  return { open24h, ...(dailyGapNote ? { dailyGapNote } : {}), summary, eveningsOrWeekends: lateClose || weekend };
}
