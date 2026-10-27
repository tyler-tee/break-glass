import { createHash } from 'node:crypto';
import type {
  BusinessStatus,
  FieldChange,
  LocationStatus,
  TrackedFields,
  WeeklyHours,
} from './types.js';

/** Structural view of a location row; keeps the domain layer free of feature imports. */
export type LocationLike = {
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  hours: WeeklyHours | null;
  businessStatus: BusinessStatus | null;
  rating: number | null;
  ratingCount: number | null;
  afterHoursNotes: string | null;
  walkIns: boolean | null;
  insuranceNotes: string | null;
};

const KEYS: (keyof TrackedFields)[] = [
  'name',
  'address',
  'phone',
  'website',
  'hours',
  'businessStatus',
  'rating',
  'ratingCount',
  'afterHoursNotes',
  'walkIns',
  'insuranceNotes',
];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, stable(obj[k])]),
    );
  }
  return value;
}

export function hashTracked(t: TrackedFields): string {
  return createHash('sha256').update(JSON.stringify(stable(t))).digest('hex');
}

export function trackedFromLocation(loc: LocationLike): TrackedFields {
  return {
    name: loc.name ?? null,
    address: loc.address ?? null,
    phone: loc.phone ?? null,
    website: loc.website ?? null,
    hours: loc.hours ?? null,
    businessStatus: loc.businessStatus ?? null,
    rating: loc.rating ?? null,
    ratingCount: loc.ratingCount ?? null,
    afterHoursNotes: loc.afterHoursNotes ?? null,
    walkIns: loc.walkIns ?? null,
    insuranceNotes: loc.insuranceNotes ?? null,
  };
}

function cleanString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

function canonicalHours(h: WeeklyHours | null | undefined): WeeklyHours | null {
  if (!h) return null;
  const periods = {} as WeeklyHours['periods'];
  for (const day of ['0', '1', '2', '3', '4', '5', '6'] as const) {
    periods[day] = [...(h.periods[day] ?? [])]
      .map((i) => ({ open: i.open, close: i.close }))
      .sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0));
  }
  return { periods, weekdayText: h.weekdayText };
}

export function normalizeTracked(raw: Partial<TrackedFields>): TrackedFields {
  return {
    name: cleanString(raw.name),
    address: cleanString(raw.address),
    phone: cleanString(raw.phone),
    website: cleanString(raw.website),
    hours: canonicalHours(raw.hours),
    businessStatus: raw.businessStatus ?? null,
    rating: raw.rating == null ? null : Math.round(raw.rating * 10) / 10,
    ratingCount: raw.ratingCount == null ? null : Math.round(raw.ratingCount),
    afterHoursNotes: cleanString(raw.afterHoursNotes),
    walkIns: typeof raw.walkIns === 'boolean' ? raw.walkIns : null,
    insuranceNotes: cleanString(raw.insuranceNotes),
  };
}

export function phoneDigits(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const out = (phone.trim().startsWith('+') ? '+' : '') + digits;
  return out === '' || out === '+' ? null : out;
}

// Compare phones ignoring formatting and a US country code (+1 801... == 801...).
function phoneKey(phone: string | null): string | null {
  const d = phoneDigits(phone)?.replace('+', '') ?? null;
  return d !== null && d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

function comparable(key: keyof TrackedFields, t: TrackedFields): string | null {
  if (key === 'phone') return phoneKey(t.phone);
  if (key === 'hours') return t.hours ? JSON.stringify(t.hours.periods) : null;
  const v = t[key];
  return v === null ? null : String(v);
}

function display(key: keyof TrackedFields, t: TrackedFields): string | null {
  if (key === 'hours') return t.hours ? JSON.stringify(t.hours) : null;
  const v = t[key];
  return v === null ? null : String(v);
}

export function diffTracked(prev: TrackedFields | null, next: TrackedFields): FieldChange[] {
  if (prev === null) return [];
  const changes: FieldChange[] = [];
  for (const key of KEYS) {
    if (comparable(key, prev) !== comparable(key, next)) {
      changes.push({ field: key, oldValue: display(key, prev), newValue: display(key, next) });
    }
  }
  return changes;
}

export type TransitionInput = {
  current: LocationStatus;
  fetchOk: boolean;
  failures: number;
  changes: FieldChange[];
  failureThreshold: number;
  ratingWarnDelta: number;
};

export type TransitionResult = {
  status: LocationStatus;
  failures: number;
  changeRows: FieldChange[];
  writeSnapshot: boolean;
  touchVerified: boolean;
};

function isWarnworthy(c: FieldChange, ratingWarnDelta: number): boolean {
  if (c.field === 'ratingCount') return false;
  if (c.field !== 'rating') return true;
  if (c.oldValue === null || c.newValue === null) return true;
  return Math.abs(Number(c.newValue) - Number(c.oldValue)) >= ratingWarnDelta;
}

export function decideTransition(input: TransitionInput): TransitionResult {
  const { current, fetchOk, changes, failureThreshold, ratingWarnDelta } = input;
  // Defensive: callers never refresh candidate/rejected locations; leave them untouched.
  if (current === 'candidate' || current === 'rejected') {
    return {
      status: current,
      failures: input.failures,
      changeRows: [],
      writeSnapshot: false,
      touchVerified: false,
    };
  }
  if (!fetchOk) {
    const failures = input.failures + 1;
    const hitThreshold = failures === failureThreshold;
    return {
      status: hitThreshold ? 'warn' : current,
      failures,
      changeRows: hitThreshold
        ? [
            {
              field: 'verification',
              oldValue: null,
              newValue: `could not verify after ${failures} attempts`,
            },
          ]
        : [],
      writeSnapshot: false,
      touchVerified: false,
    };
  }
  if (changes.length === 0) {
    return { status: current, failures: 0, changeRows: [], writeSnapshot: false, touchVerified: true };
  }
  return {
    status: changes.some((c) => isWarnworthy(c, ratingWarnDelta)) ? 'warn' : current,
    failures: 0,
    changeRows: changes,
    writeSnapshot: true,
    touchVerified: true,
  };
}
