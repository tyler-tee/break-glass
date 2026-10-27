import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { placesUsage } from '../../db/schema.js';
import type { Env } from '../../env.js';

export type BudgetReason = 'run' | 'month';

export class BudgetExhausted extends Error {
  constructor(
    message: string,
    readonly reason: BudgetReason,
  ) {
    super(message);
    this.name = 'BudgetExhausted';
  }
}

export type UsageLedger = {
  month(now: Date): string;
  get(month: string): number;
  add(month: string, n: number, now: Date): void;
};

export function dbLedger(db: Db): UsageLedger {
  return {
    month: (now) => now.toISOString().slice(0, 7),
    get: (month) =>
      db.select({ calls: placesUsage.calls }).from(placesUsage).where(eq(placesUsage.month, month)).get()?.calls ?? 0,
    add: (month, n, now) => {
      db.insert(placesUsage)
        .values({ month, calls: n, updatedAt: now })
        .onConflictDoUpdate({
          target: placesUsage.month,
          set: { calls: sql`${placesUsage.calls} + ${n}`, updatedAt: now },
        })
        .run();
    },
  };
}

export class CallBudget {
  used = 0;
  private readonly ledger: UsageLedger | undefined;
  private readonly monthlyCap: number;
  private readonly now: () => Date;

  constructor(
    readonly cap: number,
    opts: { ledger?: UsageLedger; monthlyCap?: number; now?: () => Date } = {},
  ) {
    this.ledger = opts.ledger;
    this.monthlyCap = opts.monthlyCap ?? Infinity;
    this.now = opts.now ?? (() => new Date());
  }

  take(): void {
    if (this.used >= this.cap) {
      throw new BudgetExhausted(`Places run budget of ${this.cap} calls exhausted`, 'run');
    }
    if (this.ledger) {
      const at = this.now();
      const month = this.ledger.month(at);
      if (this.ledger.get(month) >= this.monthlyCap) {
        throw new BudgetExhausted(`Places monthly cap of ${this.monthlyCap} calls reached for ${month}`, 'month');
      }
      this.ledger.add(month, 1, at);
    }
    this.used++;
  }

  remaining(): number {
    return this.cap - this.used;
  }

  monthUsed(): number {
    return this.ledger ? this.ledger.get(this.ledger.month(this.now())) : 0;
  }
}

export function newPlacesBudget(
  db: Db,
  env: Pick<Env, 'PLACES_CALL_CAP' | 'PLACES_MONTHLY_CAP'>,
  now?: () => Date,
): CallBudget {
  return new CallBudget(env.PLACES_CALL_CAP, {
    ledger: dbLedger(db),
    monthlyCap: env.PLACES_MONTHLY_CAP,
    ...(now ? { now } : {}),
  });
}
