import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { updateSettings } from '../../src/features/admin/settingsRepo.js';
import { startScheduler, type CronLike } from '../../src/jobs/scheduler.js';
import { createTestDb } from '../helpers/testDb.js';

type Call = {
  expr: string;
  timezone: string;
  fn: () => void | Promise<void>;
  stop: ReturnType<typeof vi.fn>;
};

function makeFakeCron(): { cron: CronLike; calls: Call[] } {
  const calls: Call[] = [];
  const cron: CronLike = {
    schedule(expr, fn, opts) {
      const stop = vi.fn();
      calls.push({ expr, timezone: opts.timezone, fn, stop });
      return { stop };
    },
    validate: (expr) => expr !== 'bad',
  };
  return { cron, calls };
}

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let db: Db;
let log: ReturnType<typeof makeLog>;
let fake: ReturnType<typeof makeFakeCron>;

beforeEach(() => {
  db = createTestDb();
  log = makeLog();
  fake = makeFakeCron();
});

const jobsOf = (refresh: () => Promise<unknown> = async () => ({})) => ({
  refreshLocations: refresh,
  recheckProtocols: async () => {},
});

describe('scheduler', () => {
  it('schedules both jobs with settings cron and timezone', () => {
    startScheduler({ db, jobs: jobsOf(), cron: fake.cron, log });
    expect(fake.calls.map((c) => [c.expr, c.timezone])).toEqual([
      ['0 3 * * 0', 'America/Denver'],
      ['0 4 1 * *', 'America/Denver'],
    ]);
  });

  it('reschedule uses updated settings', () => {
    const scheduler = startScheduler({ db, jobs: jobsOf(), cron: fake.cron, log });
    updateSettings(db, { locationRefreshCron: '0 2 * * 1', homeTz: 'America/Los_Angeles' });
    scheduler.reschedule();
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[0]!.stop).toHaveBeenCalledTimes(1);
    expect(fake.calls[1]!.stop).toHaveBeenCalledTimes(1);
    expect(fake.calls[2]!.expr).toBe('0 2 * * 1');
    expect(fake.calls[2]!.timezone).toBe('America/Los_Angeles');
    expect(fake.calls[3]!.timezone).toBe('America/Los_Angeles');
  });

  it('invalid cron is skipped with a warning', () => {
    db.update(settings).set({ protocolRefreshCron: 'bad' }).where(eq(settings.id, 1)).run();
    startScheduler({ db, jobs: jobsOf(), cron: fake.cron, log });
    expect(fake.calls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('second concurrent runNow returns already_running', async () => {
    const gate = deferred();
    const job = vi.fn(() => gate.promise);
    const scheduler = startScheduler({ db, jobs: jobsOf(job), cron: fake.cron, log });
    const first = scheduler.runNow('refreshLocations');
    expect(scheduler.running.has('refreshLocations')).toBe(true);
    await expect(scheduler.runNow('refreshLocations')).resolves.toBe('already_running');
    gate.resolve();
    await expect(first).resolves.toBe('done');
    expect(job).toHaveBeenCalledTimes(1);
    expect(scheduler.running.size).toBe(0);
  });

  it('cron tick while running is skipped', async () => {
    const gate = deferred();
    const job = vi.fn(() => gate.promise);
    const scheduler = startScheduler({ db, jobs: jobsOf(job), cron: fake.cron, log });
    const first = scheduler.runNow('refreshLocations');
    await fake.calls[0]!.fn();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('skipped'));
    expect(job).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
  });

  it('job error is caught', async () => {
    const scheduler = startScheduler({
      db,
      jobs: jobsOf(async () => {
        throw new Error('boom');
      }),
      cron: fake.cron,
      log,
    });
    await expect(scheduler.runNow('refreshLocations')).resolves.toBe('failed');
    expect(log.error).toHaveBeenCalled();
    expect(scheduler.running.size).toBe(0);
  });

  it('stop stops both tasks', () => {
    const scheduler = startScheduler({ db, jobs: jobsOf(), cron: fake.cron, log });
    scheduler.stop();
    expect(fake.calls[0]!.stop).toHaveBeenCalledTimes(1);
    expect(fake.calls[1]!.stop).toHaveBeenCalledTimes(1);
  });
});
