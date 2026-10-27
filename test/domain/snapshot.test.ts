import { describe, it, expect } from 'vitest';
import {
  decideTransition,
  diffTracked,
  hashTracked,
  normalizeTracked,
} from '../../src/domain/snapshot.js';
import type { FieldChange, LocationStatus, TrackedFields, WeeklyHours } from '../../src/domain/types.js';

const empty = { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] };
const hours = (weekdayText: string[] = []): WeeklyHours => ({
  periods: { ...empty, '1': [{ open: '0900', close: '1700' }] },
  weekdayText,
});

const base = (over: Partial<TrackedFields> = {}): TrackedFields =>
  normalizeTracked({
    name: 'Clinic',
    address: '1 Main St',
    phone: '(801) 555-0100',
    website: 'https://example.com',
    hours: hours(),
    businessStatus: 'OPERATIONAL',
    rating: 4.3,
    ratingCount: 10,
    ...over,
  });

const decide = (
  over: Partial<{ current: LocationStatus; fetchOk: boolean; failures: number; changes: FieldChange[] }>,
) =>
  decideTransition({
    current: 'approved',
    fetchOk: true,
    failures: 0,
    changes: [],
    failureThreshold: 3,
    ratingWarnDelta: 0.5,
    ...over,
  });

describe('hashTracked', () => {
  it('is order-independent', () => {
    const a = base();
    const b = Object.fromEntries(Object.entries(a).reverse()) as TrackedFields;
    b.hours = {
      weekdayText: [],
      periods: Object.fromEntries(Object.entries(a.hours!.periods).reverse()) as WeeklyHours['periods'],
    };
    expect(hashTracked(b)).toBe(hashTracked(a));
  });
});

describe('normalizeTracked', () => {
  it('trims and nulls blanks', () => {
    const n = normalizeTracked({
      name: '  Big   Clinic ',
      address: '   ',
      phone: ' (801)  555-0100 ',
      rating: 4.26,
      ratingCount: 10.7,
    });
    expect(n).toEqual({
      name: 'Big Clinic',
      address: null,
      phone: '(801) 555-0100',
      website: null,
      hours: null,
      businessStatus: null,
      rating: 4.3,
      ratingCount: 11,
      afterHoursNotes: null,
      walkIns: null,
      insuranceNotes: null,
    });
  });

  it('sorts each day by open and keeps weekdayText', () => {
    const n = normalizeTracked({
      hours: {
        periods: { ...empty, '2': [{ open: '1300', close: '1700' }, { open: '0800', close: '1200' }] },
        weekdayText: ['x'],
      },
    });
    expect(n.hours!.periods['2']).toEqual([
      { open: '0800', close: '1200' },
      { open: '1300', close: '1700' },
    ]);
    expect(n.hours!.weekdayText).toEqual(['x']);
  });
});

describe('diffTracked', () => {
  it('returns [] when prev is null', () => {
    expect(diffTracked(null, base())).toEqual([]);
  });

  it('phone formatting change is not a change', () => {
    expect(
      diffTracked(base({ phone: '+1 801-555-0100' }), base({ phone: '(801) 555-0100' })),
    ).toEqual([]);
  });

  it('hours comparison ignores weekdayText', () => {
    expect(diffTracked(base({ hours: hours(['a']) }), base({ hours: hours(['b']) }))).toEqual([]);
  });

  it('reports changes in fixed key order as strings', () => {
    const prev = base();
    const next = base({ phone: '8015550199', rating: 4.5, walkIns: true, website: null });
    expect(diffTracked(prev, next)).toEqual([
      { field: 'phone', oldValue: '(801) 555-0100', newValue: '8015550199' },
      { field: 'website', oldValue: 'https://example.com', newValue: null },
      { field: 'rating', oldValue: '4.3', newValue: '4.5' },
      { field: 'walkIns', oldValue: null, newValue: 'true' },
    ]);
  });
});

describe('decideTransition', () => {
  it('unchanged -> touchVerified, no snapshot, status kept', () => {
    expect(decide({})).toEqual({
      status: 'approved',
      failures: 0,
      changeRows: [],
      writeSnapshot: false,
      touchVerified: true,
    });
  });

  it('changed phone -> warn with one change row', () => {
    const changes = [{ field: 'phone', oldValue: '1', newValue: '2' }] as FieldChange[];
    expect(decide({ changes, failures: 2 })).toEqual({
      status: 'warn',
      failures: 0,
      changeRows: changes,
      writeSnapshot: true,
      touchVerified: true,
    });
  });

  it('rating 4.3 -> 4.5 -> rows written, status approved', () => {
    const changes = [{ field: 'rating', oldValue: '4.3', newValue: '4.5' }] as FieldChange[];
    expect(decide({ changes })).toEqual({
      status: 'approved',
      failures: 0,
      changeRows: changes,
      writeSnapshot: true,
      touchVerified: true,
    });
  });

  it('ratingCount-only change does not warn', () => {
    const changes = [{ field: 'ratingCount', oldValue: '1', newValue: '50' }] as FieldChange[];
    expect(decide({ changes }).status).toBe('approved');
  });

  it('rating 4.5 -> 3.9 -> warn', () => {
    const changes = [{ field: 'rating', oldValue: '4.5', newValue: '3.9' }] as FieldChange[];
    expect(decide({ changes }).status).toBe('warn');
  });

  it('null rating counts as a hard change', () => {
    const changes = [{ field: 'rating', oldValue: null, newValue: '4.5' }] as FieldChange[];
    expect(decide({ changes }).status).toBe('warn');
  });

  it('CLOSED_PERMANENTLY -> warn', () => {
    const changes = [
      { field: 'businessStatus', oldValue: 'OPERATIONAL', newValue: 'CLOSED_PERMANENTLY' },
    ] as FieldChange[];
    expect(decide({ changes }).status).toBe('warn');
  });

  it('third consecutive failure -> warn with verification row; fourth adds no second row', () => {
    expect(decide({ fetchOk: false, failures: 0 })).toEqual({
      status: 'approved',
      failures: 1,
      changeRows: [],
      writeSnapshot: false,
      touchVerified: false,
    });
    expect(decide({ fetchOk: false, failures: 2 })).toEqual({
      status: 'warn',
      failures: 3,
      changeRows: [
        { field: 'verification', oldValue: null, newValue: 'could not verify after 3 attempts' },
      ],
      writeSnapshot: false,
      touchVerified: false,
    });
    expect(decide({ current: 'warn', fetchOk: false, failures: 3 })).toEqual({
      status: 'warn',
      failures: 4,
      changeRows: [],
      writeSnapshot: false,
      touchVerified: false,
    });
  });

  it('warn when already warn stays warn and still writes rows', () => {
    const changes = [{ field: 'rating', oldValue: '4.3', newValue: '4.4' }] as FieldChange[];
    expect(decide({ current: 'warn', changes })).toEqual({
      status: 'warn',
      failures: 0,
      changeRows: changes,
      writeSnapshot: true,
      touchVerified: true,
    });
  });

  it('candidate/rejected are returned unchanged with no rows', () => {
    const changes = [{ field: 'phone', oldValue: '1', newValue: '2' }] as FieldChange[];
    for (const current of ['candidate', 'rejected'] as const) {
      const r = decide({ current, changes, failures: 5 });
      expect(r.status).toBe(current);
      expect(r.changeRows).toEqual([]);
      expect(r.writeSnapshot).toBe(false);
    }
  });
});
