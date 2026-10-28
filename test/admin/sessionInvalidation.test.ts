import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetAdmin } from '../../src/cli/reset-admin.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { createSetupCodeManager } from '../../src/features/admin/setupCode.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const quiet = { info() {}, warn() {}, error() {} };
const form = (fields: Record<string, string>, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

// SESSION_SECRET from the environment: the app cannot rotate it, so sign-out must come from the admin hash.
async function harness() {
  const db = createTestDb();
  const env = loadEnv({ SESSION_SECRET: 'e'.repeat(32) });
  const secrets = createSecretsStore(db, env);
  secrets.setAdminHash(await hashPassword('correct horse battery'));
  const setupCode = createSetupCodeManager({ log: quiet });
  const app = createApp({ db, env, secrets, setupCode });
  return { db, env, secrets, setupCode, app };
}

describe('session invalidation with an env SESSION_SECRET', () => {
  it('a password change invalidates a cookie issued before it', async () => {
    const { app } = await harness();
    const other = await adminLogin(app, 'correct horse battery'); // another device
    const mine = await adminLogin(app, 'correct horse battery');
    expect((await app.request('/admin', { headers: { cookie: other } })).status).toBe(200);
    const res = await app.request(
      '/admin/settings/password',
      form({ current: 'correct horse battery', new: 'a brand new passphrase', confirm: 'a brand new passphrase' }, mine),
    );
    expect(res.status).toBe(302);
    const fresh = res.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/admin', { headers: { cookie: other } })).status).toBe(302);
    expect((await app.request('/admin', { headers: { cookie: mine } })).status).toBe(302);
    expect((await app.request('/admin', { headers: { cookie: fresh } })).status).toBe(200);
  });

  it('resetAdmin then re-claiming does not revive a cookie from before the reset', async () => {
    const { db, env, setupCode, app } = await harness();
    const old = await adminLogin(app, 'correct horse battery');
    expect((await app.request('/admin', { headers: { cookie: old } })).status).toBe(200);
    expect(resetAdmin(db, env, quiet)).toBe('reset');
    // Re-claim with the same password: the stored hash gets a new salt, so the signing key changes.
    expect((await app.request('/setup')).status).toBe(200);
    const code = setupCode.current()!;
    const claim = await app.request('/setup', form({ code, password: 'correct horse battery', confirm: 'correct horse battery' }));
    expect(claim.status).toBe(302);
    expect((await app.request('/admin', { headers: { cookie: old } })).status).toBe(302);
    const fresh = claim.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/admin', { headers: { cookie: fresh } })).status).toBe(200);
  });
});
