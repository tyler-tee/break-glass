import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { getSettings } from '../../src/features/admin/settingsRepo.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

let app: ReturnType<typeof createApp>;
let db: Db;
let reschedule: ReturnType<typeof vi.fn>;
let cookie: string;

beforeEach(async () => {
  db = createTestDb();
  reschedule = vi.fn();
  app = createApp({
    db,
    env: loadEnv({
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    }),
    scheduler: { reschedule },
  });
  cookie = await adminLogin(app, 'correct horse');
});

const valid = {
  home_label: 'Casa',
  home_lat: '40.5',
  home_lng: '-111.9',
  default_radius_mi: '20',
  home_tz: 'America/Los_Angeles',
  location_refresh_cron: '0 2 * * 1',
  protocol_refresh_cron: '0 5 2 * *',
};

const post = (fields: Record<string, string>) =>
  app.request('/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString(),
  });

describe('admin settings', () => {
  it('settings page requires login', async () => {
    const res = await app.request('/admin/settings');
    expect(res.status).toBe(302);
  });

  it('shows current settings', async () => {
    const res = await app.request('/admin/settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('America/Denver');
    expect(body).toContain('0 3 * * 0');
  });

  it('rejects invalid cron', async () => {
    const res = await post({ ...valid, location_refresh_cron: 'every day' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('location_refresh_cron');
    expect(getSettings(db).locationRefreshCron).toBe('0 3 * * 0');
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('rejects invalid timezone', async () => {
    const res = await post({ ...valid, home_tz: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    expect(getSettings(db).homeTz).toBe('America/Denver');
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('saves valid settings', async () => {
    const res = await post(valid);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/settings?saved=1');
    expect(getSettings(db)).toMatchObject({
      homeLabel: 'Casa',
      homeLat: 40.5,
      homeLng: -111.9,
      defaultRadiusMi: 20,
      homeTz: 'America/Los_Angeles',
      locationRefreshCron: '0 2 * * 1',
      protocolRefreshCron: '0 5 2 * *',
    });
    expect(reschedule).toHaveBeenCalledTimes(1);
  });
});
