import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { seed } from '../../src/db/seed.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { getSettings } from '../../src/features/admin/settingsRepo.js';
import { dbLedger } from '../../src/services/places/budget.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const now = new Date('2026-10-27T16:00:00Z');

let db: Db;

const env = async () =>
  loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') });

beforeEach(() => {
  db = createTestDb();
  seed(db);
});

const makeApp = async (withPlaces: boolean) => {
  const deps: AppDeps = { db, env: await env(), now: () => now };
  if (withPlaces) deps.places = { fetch: recordingFetch(FIXTURE_DIR, 'replay'), apiKey: 'test' };
  const app = createApp(deps);
  return { app, cookie: await adminLogin(app, 'correct horse') };
};

const post = (app: ReturnType<typeof createApp>, cookie: string, url: string, body = '') =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });

describe('geocode route', () => {
  it('sets the home location', async () => {
    const { app, cookie } = await makeApp(true);
    const address = '200 S Main St, Salt Lake City';
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address }).toString());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/settings?saved=1');
    expect(getSettings(db)).toMatchObject({ homeLabel: address, homeLat: 40.7684, homeLng: -111.8898 });
  });

  it('400 when address not found', async () => {
    const { app, cookie } = await makeApp(true);
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'nowhere zzz' }).toString());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Address not found');
    expect(getSettings(db).homeLat).toBe(40.7608);
  });

  it('400 without places dep', async () => {
    const { app, cookie } = await makeApp(false);
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'x' }).toString());
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Add a Google Places key in Setup → Services to enable address lookup.');
    expect(html).toContain('href="/admin/setup/services"');
  });

  it('returns 429 when the monthly cap is reached', async () => {
    const ledger = dbLedger(db);
    ledger.add(ledger.month(now), 800, now);
    const { app, cookie } = await makeApp(true);
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'x' }).toString());
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Places call cap reached (month)');
  });

  it('maps PlacesError to 502', async () => {
    const forbiddenFetch = (async () =>
      new Response('{"error":{"message":"API key invalid"}}', { status: 403 })) as unknown as typeof fetch;
    const app = createApp({ db, env: await env(), now: () => now, places: { fetch: forbiddenFetch, apiKey: 'bad' } });
    const cookie = await adminLogin(app, 'correct horse');
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'x' }).toString());
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Places API error 403');
  });
});
