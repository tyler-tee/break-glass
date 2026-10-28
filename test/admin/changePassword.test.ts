import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createSecretsStore, type SecretsStore } from '../../src/features/admin/secrets.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const form = (cookie: string, body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams(body).toString(),
});

describe('change password (DB-held hash)', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let secrets: SecretsStore;
  let cookie: string;
  let oldHash: string;

  beforeEach(async () => {
    db = createTestDb();
    const env = loadEnv({});
    secrets = createSecretsStore(db, env);
    oldHash = await hashPassword('correct horse battery');
    secrets.setAdminHash(oldHash);
    app = createApp({ db, env, secrets });
    cookie = await adminLogin(app, 'correct horse battery');
  });

  it('changes with correct current, signs out other devices, keeps this one', async () => {
    const res = await app.request(
      '/admin/settings/password',
      form(cookie, { current: 'correct horse battery', new: 'a brand new passphrase', confirm: 'a brand new passphrase' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/settings?saved=1');
    const fresh = res.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(302); // old cookie dead
    expect((await app.request('/admin', { headers: { cookie: fresh } })).status).toBe(200);
    const login = (pw: string) =>
      app.request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pw }).toString() });
    expect((await login('a brand new passphrase')).status).toBe(302);
    expect((await login('correct horse battery')).status).toBe(401);
  });

  it.each([
    ['wrong current', { current: 'nope nope nope', new: 'a brand new passphrase', confirm: 'a brand new passphrase' }, 'current'],
    ['mismatch', { current: 'correct horse battery', new: 'a brand new passphrase', confirm: 'different passphrase!' }, 'confirm'],
    ['short', { current: 'correct horse battery', new: 'short', confirm: 'short' }, 'new'],
  ])('rejects %s with 400, hash unchanged, no password echoed', async (_n, body, _f) => {
    const res = await app.request('/admin/settings/password', form(cookie, body));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    for (const v of new Set(Object.values(body))) expect(html).not.toContain(`value="${v}"`);
    expect(secrets.getAdminHash()).toBe(oldHash);
  });

  it('GET shows the enabled form', async () => {
    const html = await (await app.request('/admin/settings', { headers: { cookie } })).text();
    expect(html).toContain('autocomplete="new-password"');
    expect(html).not.toContain('Set by the server environment');
  });
});

describe('change password (env-provided hash)', () => {
  it('disabled form, POST is a 400 no-op', async () => {
    const db = createTestDb();
    const hash = await hashPassword('correct horse battery');
    const env = loadEnv({ ADMIN_PASSWORD_HASH: hash });
    const secrets = createSecretsStore(db, env);
    const app = createApp({ db, env, secrets });
    const cookie = await adminLogin(app, 'correct horse battery');
    const html = await (await app.request('/admin/settings', { headers: { cookie } })).text();
    expect(html).toContain('Set by the server environment');
    expect(html).toContain('ADMIN_PASSWORD_HASH');
    const res = await app.request(
      '/admin/settings/password',
      form(cookie, { current: 'correct horse battery', new: 'a brand new passphrase', confirm: 'a brand new passphrase' }),
    );
    expect(res.status).toBe(400);
    expect(secrets.getAdminHash()).toBe(hash);
  });
});

describe('change password hint (session secret source)', () => {
  const setup = async (envVars: Record<string, string>) => {
    const db = createTestDb();
    const env = loadEnv(envVars);
    const secrets = createSecretsStore(db, env);
    secrets.setAdminHash(await hashPassword('correct horse battery'));
    const app = createApp({ db, env, secrets });
    const cookie = await adminLogin(app, 'correct horse battery');
    return (await app.request('/admin/settings', { headers: { cookie } })).text();
  };

  it('says it signs out other devices when the session secret is app-managed', async () => {
    expect(await setup({})).toContain('signs out every other device');
  });

  it('omits that claim when SESSION_SECRET comes from the environment', async () => {
    const html = await setup({ SESSION_SECRET: 's'.repeat(32) });
    expect(html).not.toContain('signs out every other device');
    expect(html).toContain('Change password');
  });
});
