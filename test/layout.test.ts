import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { settings } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { hashPassword } from '../src/features/admin/auth.js';
import { adminLogin } from './helpers/adminLogin.js';
import { createTestDb } from './helpers/testDb.js';

let db: Db;

const mkApp = async (extra: Record<string, string> = {}) => {
  const env = loadEnv({
    SESSION_SECRET: 's'.repeat(32),
    ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    ...extra,
  });
  return createApp({ db, env, now: () => new Date('2026-10-27T16:00:00Z') });
};

beforeEach(() => {
  db = createTestDb();
});

describe('layouts', () => {
  it('404 uses the layout, not plain text', async () => {
    const res = await (await mkApp()).request('/no-such-page');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('/assets/family.css');
    expect(body).toContain('<body class="family">');
    expect(body).not.toContain('/assets/styles.css');
  });

  it('unknown asset renders the layout 404', async () => {
    const res = await (await mkApp()).request('/assets/nope.css');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('/assets/family.css');
    expect(body).toContain('<body class="family">');
  });

  it('admin page carries one admin.js script tag', async () => {
    const app = await mkApp();
    const cookie = await adminLogin(app, 'correct horse');
    const body = await (await app.request('/admin', { headers: { cookie } })).text();
    expect(body).toContain('/assets/admin.js');
    expect(body.match(/<script/g)).toHaveLength(1);
    expect(body).toContain('aria-current="page"');
    expect(body).toContain('action="/admin/logout"');
  });

  it('family page has no script tag and shows the household name', async () => {
    db.update(settings).set({ householdName: 'The Rivera home' }).where(eq(settings.id, 1)).run();
    const body = await (await (await mkApp()).request('/')).text();
    expect(body).not.toContain('<script');
    expect(body).toContain('The Rivera home');
    expect(body.indexOf('skip-link')).toBeLessThan(body.indexOf('<main'));
  });

  it('logged-out /admin/* 404 does not show the admin nav', async () => {
    const res = await (await mkApp()).request('/admin/nope');
    // requireAdmin redirects first; a logged-out visitor never sees admin chrome.
    expect(res.status).toBe(302);
  });

  it('authenticated /admin/* 404 uses the admin layout', async () => {
    const app = await mkApp();
    const cookie = await adminLogin(app, 'correct horse');
    const res = await app.request('/admin/nope', { headers: { cookie } });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('/admin/logout');
    expect(body).toContain('/assets/styles.css');
  });

  it('onError renders a generic page without leaking the message', async () => {
    const app = await mkApp();
    app.get('/boom', () => {
      throw new Error('secret-detail-xyz');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('/assets/family.css');
    expect(body).toContain('<body class="family">');
    expect(body).not.toContain('secret-detail-xyz');
  });

  it('Setup nav item appears only while install is incomplete', async () => {
    const app = await mkApp();
    const cookie = await adminLogin(app, 'correct horse');
    const get = async () => (await app.request('/admin', { headers: { cookie } })).text();
    expect(await get()).toContain('<li><a href="/admin/setup"');
    db.update(settings).set({ setupCompletedAt: new Date() }).where(eq(settings.id, 1)).run();
    // The overview itself links "Run setup again" once ready; only the nav item must disappear.
    expect(await get()).not.toContain('<li><a href="/admin/setup"');
  });
});
