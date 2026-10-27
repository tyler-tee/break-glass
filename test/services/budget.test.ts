import { describe, expect, it } from 'vitest';
import { placesUsage } from '../../src/db/schema.js';
import { BudgetExhausted, CallBudget, dbLedger } from '../../src/services/places/budget.js';
import { createTestDb } from '../helpers/testDb.js';

const OCT = new Date('2026-10-27T16:00:00Z');
const NOV = new Date('2026-11-02T16:00:00Z');

describe('places call budget', () => {
  it('monthly cap persists across runs', () => {
    const db = createTestDb();
    const ledger = dbLedger(db);
    const first = new CallBudget(10, { ledger, monthlyCap: 3, now: () => OCT });
    first.take();
    first.take();
    const second = new CallBudget(10, { ledger, monthlyCap: 3, now: () => OCT });
    second.take();
    const err = (() => {
      try {
        second.take();
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(BudgetExhausted);
    expect((err as BudgetExhausted).reason).toBe('month');
    expect(second.used).toBe(1);
    expect(db.select().from(placesUsage).all()).toMatchObject([{ month: '2026-10', calls: 3 }]);
  });

  it('month rollover resets', () => {
    const ledger = dbLedger(createTestDb());
    const oct = new CallBudget(10, { ledger, monthlyCap: 1, now: () => OCT });
    oct.take();
    expect(() => oct.take()).toThrow(BudgetExhausted);
    const nov = new CallBudget(10, { ledger, monthlyCap: 1, now: () => NOV });
    expect(() => nov.take()).not.toThrow();
    expect(nov.monthUsed()).toBe(1);
    expect(ledger.get('2026-10')).toBe(1);
    expect(ledger.get('2026-11')).toBe(1);
  });

  it('run cap reason is run', () => {
    const ledger = dbLedger(createTestDb());
    const b = new CallBudget(1, { ledger, monthlyCap: 100, now: () => OCT });
    b.take();
    try {
      b.take();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhausted);
      expect((e as BudgetExhausted).reason).toBe('run');
    }
  });

  it('monthUsed reports ledger total', () => {
    const ledger = dbLedger(createTestDb());
    ledger.add('2026-10', 5, OCT);
    const b = new CallBudget(10, { ledger, monthlyCap: 100, now: () => OCT });
    expect(b.monthUsed()).toBe(5);
    b.take();
    expect(b.monthUsed()).toBe(6);
  });

  it('works without a ledger', () => {
    const b = new CallBudget(1);
    b.take();
    expect(b.monthUsed()).toBe(0);
    expect(() => b.take()).toThrow(BudgetExhausted);
  });
});
