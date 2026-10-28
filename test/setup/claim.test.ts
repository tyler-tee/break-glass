import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword, verifyPassword } from '../../src/features/admin/auth.js';
import { installState } from '../../src/features/admin/install.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { createSetupCodeManager } from '../../src/features/admin/setupCode.js';
import { createTestDb } from '../helpers/testDb.js';

const PW = 'a-long-password';
const MIN = 60 * 1000;

function harness() {
  const db = createTestDb();
  const env = loadEnv({});
  const secrets = createSecretsStore(db, env);
  let t = new Date('2026-10-27T16:00:00Z');
  const now = () => t;
  const logs: string[] = [];
  const log = {
    info: (...a: unknown[]) => logs.push(a.join(' ')),
    warn: (...a: unknown[]) => logs.push(a.join(' ')),
    error: (...a: unknown[]) => logs.push(a.join(' ')),
  };
  const setupCode = createSetupCodeManager({ now, log });
  const app = createApp({ db, env, secrets, setupCode, now });
  const claim = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  return {
    db,
    app,
    secrets,
    setupCode,
    logs,
    claim,
    advance: (ms: number) => {
      t = new Date(t.getTime() + ms);
    },
  };
}

/** A well-formed code that is guaranteed not to be the active one. */
const wrongCode = (code: string) => (code.startsWith('0') ? '1111-1111' : '0000-0000');

describe('setup code manager', () => {
  it('generates a Crockford base32 XXXX-XXXX code lazily and idempotently, printing it once', () => {
    const logs: string[] = [];
    const m = createSetupCodeManager({ now: () => new Date(), log: { info: (s: unknown) => logs.push(String(s)), warn() {}, error() {} } });
    expect(m.current()).toBeNull();
    expect(logs).toEqual([]);
    const code = m.ensure();
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    expect(m.ensure()).toBe(code);
    expect(m.current()).toBe(code);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(code);
    expect(logs[0]).toContain('/setup');
  });

  it('accepts lowercase and undashed input, and is one-time', () => {
    const m = createSetupCodeManager({ now: () => new Date(), log: { info() {}, warn() {}, error() {} } });
    const code = m.ensure();
    expect(m.consume(` ${code.replace('-', '').toLowerCase()} `)).toBe('ok');
    expect(m.current()).toBeNull();
    expect(m.consume(code)).toBe('wrong');
  });

  it('rejects wrong-length and empty input as wrong', () => {
    const m = createSetupCodeManager({ now: () => new Date(), log: { info() {}, warn() {}, error() {} } });
    const code = m.ensure();
    expect(m.consume('')).toBe('wrong');
    expect(m.consume(code + 'A')).toBe('wrong');
    expect(m.current()).toBe(code);
  });

  it('issues a fresh code after reset', () => {
    const m = createSetupCodeManager({ now: () => new Date(), log: { info() {}, warn() {}, error() {} } });
    const first = m.ensure();
    m.reset();
    expect(m.current()).toBeNull();
    // 40 random bits: a collision here is a 1-in-2^40 event.
    expect(m.ensure()).not.toBe(first);
  });
});

describe('/setup claim', () => {
  it('requires the code', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const res = await h.claim({ code: wrongCode(code), password: PW, confirm: PW });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('role="alert"');
    expect(body).not.toContain(code);
    expect(h.secrets.getAdminHash()).toBeUndefined();
    expect(installState(h)).toBe('unclaimed');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('claims with the right code', async () => {
    const h = harness();
    const get = await h.app.request('/setup');
    expect(get.status).toBe(200);
    const html = await get.text();
    const code = h.setupCode.current();
    expect(code).not.toBeNull();
    expect(html).not.toContain(code!);
    expect(html).toContain('docker compose logs app');
    expect(html).toMatch(/name="code"[^>]*autocomplete="off"|autocomplete="off"[^>]*name="code"/);
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('minlength="12"');
    expect(html).toContain('spellcheck="false"');

    const res = await h.claim({ code: code!, password: PW, confirm: PW });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup');
    expect(res.headers.get('set-cookie')).toContain('bg_session=');
    const hash = h.secrets.getAdminHash();
    expect(hash).toBeDefined();
    expect(await verifyPassword(PW, hash!)).toBe(true);
    expect(h.setupCode.current()).toBeNull();

    const again = await h.app.request('/setup');
    expect(again.status).toBe(404);
    expect(await again.text()).toContain('Page not found');
    expect((await h.claim({ code: code!, password: 'another-password!', confirm: 'another-password!' })).status).toBe(404);
    expect(await verifyPassword(PW, h.secrets.getAdminHash()!)).toBe(true);
    // The session from the claim grants admin access.
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect((await h.app.request('/admin', { headers: { cookie } })).status).toBe(200);
  });

  it('accepts the code in lowercase without the dash', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const res = await h.claim({ code: code.replace('-', '').toLowerCase(), password: PW, confirm: PW });
    expect(res.status).toBe(302);
  });

  it('rate limits then recovers', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const bad = wrongCode(code);
    for (let i = 0; i < 5; i++) {
      expect((await h.claim({ code: bad, password: PW, confirm: PW })).status).toBe(401);
    }
    const sixth = await h.claim({ code: bad, password: PW, confirm: PW });
    expect(sixth.status).toBe(429);
    const lockedBody = await sixth.text();
    expect(lockedBody).toContain('role="alert"');

    // While locked, the right code gets the identical locked response and does not claim.
    const right = await h.claim({ code, password: PW, confirm: PW });
    expect(right.status).toBe(429);
    expect(await right.text()).toBe(lockedBody);
    expect(h.secrets.getAdminHash()).toBeUndefined();

    // Waiting out the plain 60s window is not enough; the lockout is 15 minutes.
    h.advance(2 * MIN);
    expect((await h.claim({ code, password: PW, confirm: PW })).status).toBe(429);

    h.advance(15 * MIN);
    const ok = await h.claim({ code, password: PW, confirm: PW });
    expect(ok.status).toBe(302);
    expect(h.secrets.getAdminHash()).toBeDefined();
  });

  it('failures spread beyond the window do not lock', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    for (let i = 0; i < 4; i++) await h.claim({ code: wrongCode(code), password: PW, confirm: PW });
    h.advance(61 * 1000);
    for (let i = 0; i < 4; i++) {
      expect((await h.claim({ code: wrongCode(code), password: PW, confirm: PW })).status).toBe(401);
    }
    expect((await h.claim({ code, password: PW, confirm: PW })).status).toBe(302);
  });

  it('a successful claim clears the failure counter', () => {
    const m = createSetupCodeManager({ now: () => new Date('2026-10-27T16:00:00Z'), log: { info() {}, warn() {}, error() {} } });
    let code = m.ensure();
    for (let i = 0; i < 4; i++) m.consume(wrongCode(code));
    expect(m.consume(code)).toBe('ok');
    code = m.ensure();
    for (let i = 0; i < 4; i++) expect(m.consume(wrongCode(code))).toBe('wrong');
    expect(m.consume(code)).toBe('ok');
  });

  it('password too short rejected', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const short = 'a'.repeat(11);
    const res = await h.claim({ code, password: short, confirm: short });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('role="alert"');
    expect(body).toContain('12 characters');
    expect(h.secrets.getAdminHash()).toBeUndefined();
    // Password errors neither consume the code nor count as a code failure.
    expect(h.setupCode.current()).toBe(code);
    for (let i = 0; i < 6; i++) await h.claim({ code: wrongCode(code), password: short, confirm: short });
    expect((await h.claim({ code, password: PW, confirm: PW })).status).toBe(302);
  });

  it('mismatched confirm rejected without consuming the code', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const res = await h.claim({ code, password: PW, confirm: PW + 'x' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('do not match');
    expect(h.secrets.getAdminHash()).toBeUndefined();
    expect(h.setupCode.current()).toBe(code);
  });

  it('two racing correct-code claims set exactly one hash', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const [a, b] = await Promise.all([
      h.claim({ code, password: 'first-password-1', confirm: 'first-password-1' }),
      h.claim({ code, password: 'second-password-2', confirm: 'second-password-2' }),
    ]);
    expect([a.status, b.status].filter((s) => s === 302)).toHaveLength(1);
    const winner = a.status === 302 ? 'first-password-1' : 'second-password-2';
    expect(await verifyPassword(winner, h.secrets.getAdminHash()!)).toBe(true);
  });

  it('rejects a cross-origin POST', async () => {
    const h = harness();
    await h.app.request('/setup');
    const code = h.setupCode.current()!;
    const res = await h.claim(
      { code, password: PW, confirm: PW },
      { host: 'break-glass.lan:3000', origin: 'http://evil.lan:3000' },
    );
    expect(res.status).toBe(403);
    expect(h.secrets.getAdminHash()).toBeUndefined();
    expect(h.setupCode.current()).toBe(code);
  });

  it('a POST with no active code generates one rather than accepting anything', async () => {
    const h = harness();
    expect(h.setupCode.current()).toBeNull();
    const res = await h.claim({ code: '', password: PW, confirm: PW });
    expect(res.status).toBe(401);
    expect(h.setupCode.current()).not.toBeNull();
    expect(h.secrets.getAdminHash()).toBeUndefined();
  });

  it('is 404 when the hash comes from env', async () => {
    const db = createTestDb();
    const app = createApp({ db, env: loadEnv({ ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }) });
    expect((await app.request('/setup')).status).toBe(404);
  });

  it('never responds with the code in a redirect or header', async () => {
    const h = harness();
    const res = await h.app.request('/admin');
    const code = h.setupCode.current()!;
    expect(code).not.toBeNull();
    for (const [, v] of res.headers) expect(v).not.toContain(code);
    expect(await res.text()).not.toContain(code);
  });
});

describe('unclaimed guards', () => {
  it('/admin redirects to /setup while unclaimed', async () => {
    const h = harness();
    const res = await h.app.request('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/setup');
    // The redirect makes sure a code exists and has been printed.
    const code = h.setupCode.current()!;
    expect(h.logs.join('\n')).toContain(code);
  });

  it('/admin/login GET and POST redirect to /setup while unclaimed', async () => {
    const h = harness();
    expect((await h.app.request('/admin/login')).headers.get('location')).toBe('/setup');
    const post = await h.app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=x&next=%2Fadmin',
    });
    expect(post.status).toBe(302);
    expect(post.headers.get('location')).toBe('/setup');
    expect((await h.app.request('/admin/settings')).headers.get('location')).toBe('/setup');
  });

  it('a reset back to unclaimed issues and prints a fresh code on the next visit', async () => {
    const h = harness();
    await h.app.request('/setup');
    const first = h.setupCode.current()!;
    await h.claim({ code: first, password: PW, confirm: PW });
    expect(h.setupCode.current()).toBeNull();
    h.secrets.clearAdminHash(); // what the reset CLI does from another process
    const res = await h.app.request('/setup');
    expect(res.status).toBe(200);
    const second = h.setupCode.current()!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(h.logs.join('\n')).toContain(second);
  });

  it('family home shows a not-set-up panel linking to /setup while unclaimed', async () => {
    const h = harness();
    const res = await h.app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/setup"');
    expect(body).toContain('not set up yet');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('Find help nearby');
  });

  it('family home is normal once claimed', async () => {
    const h = harness();
    h.secrets.setAdminHash(await hashPassword(PW));
    const body = await (await h.app.request('/')).text();
    expect(body).toContain('Preparedness kit');
    expect(body).not.toContain('href="/setup"');
  });
});

describe('resume after login', () => {
  async function claimed() {
    const h = harness();
    h.secrets.setAdminHash(await hashPassword(PW));
    const login = (body: string) =>
      h.app.request('/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    return { ...h, login };
  }

  it('a plain login page posts an empty next', async () => {
    const h = await claimed();
    const body = await (await h.app.request('/admin/login')).text();
    expect(body).toContain('name="next" value=""');
  });

  it('incomplete install with no next goes to the wizard', async () => {
    const h = await claimed();
    for (const body of [`password=${PW}`, `password=${PW}&next=`]) {
      const res = await h.login(body);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/setup');
    }
  });

  it('an explicit /admin next is honored', async () => {
    const h = await claimed();
    const res = await h.login(`password=${PW}&next=%2Fadmin%2Fcategories`);
    expect(res.headers.get('location')).toBe('/admin/categories');
  });

  it('a ready install with no next goes to the overview', async () => {
    const h = await claimed();
    const { settings } = await import('../../src/db/schema.js');
    h.db.update(settings).set({ setupCompletedAt: new Date() }).run();
    const res = await h.login(`password=${PW}`);
    expect(res.headers.get('location')).toBe('/admin');
  });
});
