import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { startScheduler, type CronLike } from '../../src/jobs/scheduler.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const fakeCron: CronLike = {
  schedule: () => ({ stop: vi.fn() }),
  validate: (expr) => expr !== 'bad',
};
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let app: ReturnType<typeof createApp>;
let cookie: string;
let refreshLocations: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const db = createTestDb();
  refreshLocations = vi.fn(async () => ({ checked: 0 }));
  app = createApp({
    db,
    env: loadEnv({
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    }),
    scheduler: startScheduler({
      db,
      jobs: { refreshLocations, recheckProtocols: vi.fn(async () => {}) },
      cron: fakeCron,
      log: silent,
    }),
  });
  cookie = await adminLogin(app, 'correct horse');
});

const run = (name: string, headers: Record<string, string> = {}) =>
  app.request(`/admin/jobs/${name}/run`, { method: 'POST', headers });

describe('admin job run', () => {
  it('run route requires login', async () => {
    const res = await run('refreshLocations');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/admin/login');
    expect(refreshLocations).not.toHaveBeenCalled();
  });

  it('run route invokes the job and redirects', async () => {
    const res = await run('refreshLocations', { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin?job=refreshLocations&result=done');
    expect(refreshLocations).toHaveBeenCalledTimes(1);
    const page = await app.request('/admin?job=refreshLocations&result=done', {
      headers: { cookie },
    });
    const body = await page.text();
    expect(body).toContain('refreshLocations: done');
    expect(body).toContain('Run location refresh now');
    expect(body).toContain('Re-check protocols now');
  });

  it('unknown job is 404', async () => {
    const res = await run('nope', { cookie });
    expect(res.status).toBe(404);
  });
});
