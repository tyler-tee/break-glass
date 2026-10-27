import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appSecrets } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { hashPassword } from '../src/features/admin/auth.js';
import { createSecretsStore } from '../src/features/admin/secrets.js';
import { makeServiceResolver } from '../src/services/resolver.js';
import { adminLogin } from './helpers/adminLogin.js';
import { createTestDb } from './helpers/testDb.js';

describe('secrets store', () => {
  it('env wins over DB', () => {
    const db = createTestDb();
    db.insert(appSecrets).values({ key: 'google_places_api_key', value: 'db-key', updatedAt: new Date() }).run();
    const store = createSecretsStore(db, loadEnv({ GOOGLE_PLACES_API_KEY: 'env-key' }));
    expect(store.getPlacesKey()).toBe('env-key');
    expect(store.isEnvProvided('placesKey')).toBe(true);
    expect(createSecretsStore(db, loadEnv({})).getPlacesKey()).toBe('db-key');
    expect(createSecretsStore(db, loadEnv({})).isEnvProvided('placesKey')).toBe(false);
  });

  it('blank save keeps existing, remove clears', () => {
    const store = createSecretsStore(createTestDb(), loadEnv({}));
    store.setPlacesKey('k');
    store.setPlacesKey('');
    store.setPlacesKey('   ');
    expect(store.getPlacesKey()).toBe('k');
    store.removePlacesKey();
    expect(store.getPlacesKey()).toBeUndefined();
  });

  it('anthropic key round-trips and env LLM_API_KEY wins', () => {
    const db = createTestDb();
    const store = createSecretsStore(db, loadEnv({}));
    expect(store.getAnthropicKey()).toBeUndefined();
    store.setAnthropicKey('db-anthropic');
    expect(store.getAnthropicKey()).toBe('db-anthropic');
    const envStore = createSecretsStore(db, loadEnv({ LLM_API_KEY: 'env-anthropic' }));
    expect(envStore.getAnthropicKey()).toBe('env-anthropic');
    expect(envStore.isEnvProvided('anthropicKey')).toBe(true);
    store.removeAnthropicKey();
    expect(store.getAnthropicKey()).toBeUndefined();
  });

  it('session secret autogenerates and persists across instances on the same DB', () => {
    const db = createTestDb();
    const env = loadEnv({});
    const first = createSecretsStore(db, env).getSessionSecret();
    const second = createSecretsStore(db, env).getSessionSecret();
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(createSecretsStore(createTestDb(), env).getSessionSecret()).not.toBe(first);
  });

  it('env SESSION_SECRET wins and is not persisted', () => {
    const db = createTestDb();
    const store = createSecretsStore(db, loadEnv({ SESSION_SECRET: 'e'.repeat(32) }));
    expect(store.getSessionSecret()).toBe('e'.repeat(32));
    expect(db.select().from(appSecrets).all()).toEqual([]);
  });

  it('cannot overwrite an env-provided secret', () => {
    const env = loadEnv({
      ADMIN_PASSWORD_HASH: 'env-hash-value',
      SESSION_SECRET: 'z'.repeat(32),
      GOOGLE_PLACES_API_KEY: 'env-places-value',
      LLM_API_KEY: 'env-llm-value',
    });
    const store = createSecretsStore(createTestDb(), env);
    expect(store.isEnvProvided('adminHash')).toBe(true);
    expect(() => store.setAdminHash('other')).toThrow(/adminHash/);
    expect(() => store.clearAdminHash()).toThrow(/adminHash/);
    expect(() => store.rotateSessionSecret()).toThrow(/sessionSecret/);
    expect(() => store.setPlacesKey('x')).toThrow(/placesKey/);
    expect(() => store.removePlacesKey()).toThrow(/placesKey/);
    expect(() => store.setAnthropicKey('x')).toThrow(/anthropicKey/);
    expect(() => store.removeAnthropicKey()).toThrow(/anthropicKey/);
    // Errors name the secret, never its value.
    for (const fn of [() => store.setAdminHash('other'), () => store.rotateSessionSecret(),
      () => store.setPlacesKey('x'), () => store.setAnthropicKey('x')]) {
      try {
        fn();
      } catch (e) {
        const msg = String((e as Error).message);
        for (const v of ['env-hash-value', 'z'.repeat(32), 'env-places-value', 'env-llm-value']) {
          expect(msg).not.toContain(v);
        }
      }
    }
    expect(store.getAdminHash()).toBe('env-hash-value');
  });

  it('admin hash set and clear in the DB', () => {
    const store = createSecretsStore(createTestDb(), loadEnv({}));
    expect(store.getAdminHash()).toBeUndefined();
    store.setAdminHash('h1');
    expect(store.getAdminHash()).toBe('h1');
    store.setAdminHash('h2');
    expect(store.getAdminHash()).toBe('h2');
    store.clearAdminHash();
    expect(store.getAdminHash()).toBeUndefined();
  });

  it('rotated session secret invalidates old cookies', async () => {
    const db = createTestDb();
    const env = loadEnv({ ADMIN_PASSWORD_HASH: await hashPassword('correct horse') });
    const secrets = createSecretsStore(db, env);
    const app = createApp({ db, env, secrets });
    const cookie = await adminLogin(app, 'correct horse');
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(200);
    secrets.rotateSessionSecret();
    const res = await app.request('/admin', { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/admin/login');
  });

  it('login works against a DB-stored admin hash with no env secrets', async () => {
    const db = createTestDb();
    const env = loadEnv({});
    const secrets = createSecretsStore(db, env);
    secrets.setAdminHash(await hashPassword('correct horse'));
    const app = createApp({ db, env, secrets });
    const cookie = await adminLogin(app, 'correct horse');
    expect((await app.request('/admin', { headers: { cookie } })).status).toBe(200);
  });
});

describe('service resolver', () => {
  it('wizard-saved Anthropic key enables the LLM', () => {
    const db = createTestDb();
    const env = loadEnv({});
    const secrets = createSecretsStore(db, env);
    const resolver = makeServiceResolver(db, env, secrets);
    expect(resolver.llm()).toBeUndefined();
    expect(resolver.extract()).toBeUndefined();
    secrets.setAnthropicKey('k');
    expect(resolver.llm()).toBeDefined();
    expect(resolver.extract()).toBeDefined();

    const offEnv = loadEnv({ LLM_PROVIDER: 'none' });
    const offResolver = makeServiceResolver(db, offEnv, createSecretsStore(db, offEnv));
    expect(offResolver.llm()).toBeUndefined();
    expect(offResolver.extract()).toBeUndefined();
  });

  it('memoizes by key and rebuilds when the key changes', () => {
    const db = createTestDb();
    const env = loadEnv({});
    const secrets = createSecretsStore(db, env);
    const resolver = makeServiceResolver(db, env, secrets);
    expect(resolver.places()).toBeUndefined();
    secrets.setPlacesKey('p1');
    const p1 = resolver.places();
    expect(p1?.apiKey).toBe('p1');
    expect(resolver.places()).toBe(p1);
    secrets.setPlacesKey('p2');
    expect(resolver.places()?.apiKey).toBe('p2');
    secrets.setAnthropicKey('a1');
    const llm1 = resolver.llm();
    const ex1 = resolver.extract();
    expect(resolver.llm()).toBe(llm1);
    expect(resolver.extract()).toBe(ex1);
    secrets.setAnthropicKey('a2');
    expect(resolver.llm()).not.toBe(llm1);
    expect(resolver.extract()).not.toBe(ex1);
    secrets.removePlacesKey();
    expect(resolver.places()).toBeUndefined();
  });
});
