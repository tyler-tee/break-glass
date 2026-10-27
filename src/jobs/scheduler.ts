import nodeCron from 'node-cron';
import type { Db } from '../db/client.js';
import type { Logger } from '../domain/types.js';
import { getSettings } from '../features/admin/settingsRepo.js';

export type JobName = 'refreshLocations' | 'recheckProtocols';
export type RunResult = 'done' | 'failed' | 'already_running';

export type CronLike = {
  schedule(
    expr: string,
    fn: () => void | Promise<void>,
    opts: { timezone: string },
  ): { stop(): void };
  validate(expr: string): boolean;
};

export type SchedulerHandle = {
  reschedule(): void;
  runNow(job: JobName): Promise<RunResult>;
  stop(): void;
  readonly running: ReadonlySet<JobName>;
};

export function startScheduler(deps: {
  db: Db;
  jobs: Record<JobName, () => Promise<unknown>>;
  cron?: CronLike;
  log: Logger;
}): SchedulerHandle {
  const { db, jobs, log } = deps;
  const cron: CronLike = deps.cron ?? nodeCron;
  const running = new Set<JobName>();
  let tasks: { stop(): void }[] = [];

  async function run(job: JobName): Promise<RunResult> {
    if (running.has(job)) {
      log.info(`${job} skipped: already running`);
      return 'already_running';
    }
    running.add(job);
    try {
      const result = await jobs[job]();
      log.info(`${job} finished`, result);
      return 'done';
    } catch (err) {
      log.error(`${job} failed`, err);
      return 'failed';
    } finally {
      running.delete(job);
    }
  }

  function stop(): void {
    for (const task of tasks) task.stop();
    tasks = [];
  }

  function reschedule(): void {
    stop();
    const s = getSettings(db);
    const entries: [JobName, string | null][] = [
      ['refreshLocations', s.locationRefreshCron],
      ['recheckProtocols', s.protocolRefreshCron],
    ];
    for (const [job, expr] of entries) {
      if (expr === null) continue;
      if (!cron.validate(expr)) {
        log.warn(`${job} not scheduled: invalid cron expression "${expr}"`);
        continue;
      }
      tasks.push(cron.schedule(expr, () => run(job).then(() => undefined), { timezone: s.homeTz }));
    }
  }

  reschedule();
  return { reschedule, runNow: run, stop, running };
}
