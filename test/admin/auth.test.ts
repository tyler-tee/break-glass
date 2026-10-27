import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword, verifyPassword } from '../../src/features/admin/auth.js';
import { createTestDb } from '../helpers/testDb.js';

let app: ReturnType<typeof createApp>;
let t: Date;

beforeEach(async () => {
  t = new Date('2026-10-27T16:00:00Z');
  app = createApp({
    db: createTestDb(),
    env: loadEnv({
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    }),
    now: () => t,
  });
});

const form = (body: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body,
});

async function login(): Promise<string> {
  const res = await app.request('/admin/login', form('password=correct+horse&next=%2Fadmin'));
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('admin auth', () => {
  it('verifyPassword accepts the right password and rejects wrong and malformed', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
    expect(await verifyPassword('correct horse', 'garbage')).toBe(false);
  });

  it('GET /admin redirects to login without a cookie', async () => {
    const res = await app.request('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin');
  });

  it('login page is public', async () => {
    const res = await app.request('/admin/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('type="password"');
  });

  it('login with the correct password sets a session cookie and redirects', async () => {
    const res = await app.request('/admin/login', form('password=correct+horse&next=%2Fadmin'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('bg_session=');
    expect(cookie).toContain('HttpOnly');
  });

  it('login ignores next outside /admin', async () => {
    const res = await app.request('/admin/login', form('password=correct+horse&next=%2F%2Fevil.example'));
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('session cookie grants access', async () => {
    const cookie = await login();
    const res = await app.request('/admin', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/admin/logout');
  });

  it('tampered cookie is rejected', async () => {
    const cookie = await login();
    const i = cookie.indexOf('=') + 3;
    const tampered = cookie.slice(0, i) + (cookie[i] === 'A' ? 'B' : 'A') + cookie.slice(i + 1);
    const res = await app.request('/admin', { headers: { cookie: tampered } });
    expect(res.status).toBe(302);
  });

  it('wrong password returns 401', async () => {
    const res = await app.request('/admin/login', form('password=nope&next=%2Fadmin'));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Wrong password');
  });

  it('expired session redirects', async () => {
    const cookie = await login();
    t = new Date(t.getTime() + 13 * 60 * 60 * 1000);
    const res = await app.request('/admin', { headers: { cookie } });
    expect(res.status).toBe(302);
  });

  it('logout clears the cookie', async () => {
    const cookie = await login();
    const res = await app.request('/admin/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
    expect(res.headers.get('set-cookie')).toContain('bg_session=;');
  });
});

describe('verifyPassword formats', () => {
  it('verifyPassword accepts colon-separated hashes', async () => {
    const h = await hashPassword('pw');
    expect(h).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword('pw', h)).toBe(true);
    expect(await verifyPassword('nope', h)).toBe(false);
  });

  it('verifyPassword still accepts legacy dollar-separated hashes', async () => {
    const legacy = (await hashPassword('pw')).replace(/:/g, '$');
    expect(legacy.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('pw', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
  });
});
