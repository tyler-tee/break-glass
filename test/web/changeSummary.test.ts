import { describe, expect, it } from 'vitest';
import { summarizeChanges } from '../../src/web/changeSummary.js';

const hours = (sat: string) =>
  JSON.stringify({ periods: {}, weekdayText: ['Friday: 8:00 AM – 5:00 PM', `Saturday: ${sat}`] });

describe('summarizeChanges', () => {
  it('names the days whose hours changed', () => {
    const s = summarizeChanges([{ field: 'hours', oldValue: hours('9:00 AM – 1:00 PM'), newValue: hours('Closed') }]);
    expect(s).toBe('Hours changed since you approved it (Sat: now closed).');
  });

  it('describes a temporary closure and a new phone number', () => {
    const s = summarizeChanges([
      { field: 'businessStatus', oldValue: 'OPERATIONAL', newValue: 'CLOSED_TEMPORARILY' },
      { field: 'phone', oldValue: '(407) 555-0100', newValue: '(407) 555-0199' },
    ]);
    expect(s).toBe('Google now lists it as temporarily closed. Phone number is now (407) 555-0199.');
  });

  it('falls back to a generic sentence for minor fields', () => {
    expect(summarizeChanges([{ field: 'website', oldValue: 'a', newValue: 'b' }])).toBe('Details changed since you approved it.');
    expect(summarizeChanges([])).toBe('Something changed since you approved it.');
  });
});
