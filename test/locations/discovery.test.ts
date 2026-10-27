import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { locations, settings } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { getSettings } from '../../src/features/admin/settingsRepo.js';
import { createCategory } from '../../src/features/categories/repo.js';
import { NoHomeLocation, runDiscovery } from '../../src/features/locations/discovery.js';
import { approveLocation } from '../../src/features/locations/service.js';
import type { Extractor } from '../../src/services/llm/extract.js';
import { CallBudget, dbLedger } from '../../src/services/places/budget.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const now = new Date('2026-10-27T16:00:00Z');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let db: Db;
let categoryId: number;

const env = async () =>
  loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') });
const discoveryDeps = (cap = 10) => ({
  places: { fetch: recordingFetch(FIXTURE_DIR, 'replay'), apiKey: 'test', budget: new CallBudget(cap) },
  now: () => now,
  log: silent,
});
const rows = () =>
  db.select().from(locations).where(eq(locations.categoryId, categoryId)).orderBy(asc(locations.distanceMi)).all();

beforeEach(() => {
  db = createTestDb();
  seed(db);
  categoryId = createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] }).id;
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

describe('runDiscovery', () => {
  it('creates deduplicated candidates with distance and rating', async () => {
    const report = await runDiscovery(db, categoryId, discoveryDeps());
    expect(report).toMatchObject({
      searched: 1,
      found: 2,
      inserted: 2,
      skipped: 0,
      detailsFetched: 2,
      stoppedEarly: false,
      callsUsed: 3,
    });
    const found = rows();
    expect(found.map((l) => l.name)).toEqual(['Near Dental Group', 'Far Dental']);
    expect(found[0]!.distanceMi).toBeGreaterThan(0);
    expect(found[1]!.distanceMi).toBeGreaterThan(found[0]!.distanceMi!);
    expect(found.map((l) => l.rating)).toEqual([4.6, 4.2]);
    expect(found.map((l) => l.phone)).toEqual(['(801) 555-0100', '(801) 555-0102']);
    expect(found.map((l) => l.placeId)).toEqual(['ChIJnear', 'ChIJfar']);
    expect(found.every((l) => l.status === 'candidate')).toBe(true);
    expect(found[0]!.hours?.periods['1']).toEqual([{ open: '0800', close: '1700' }]);
    expect(found[0]!.createdAt).toEqual(now);
  });

  it('discovery runs the extractor for candidates with websites', async () => {
    const extract = vi.fn<Extractor>(async (website) =>
      website !== 'https://near-dental.example'
        ? null
        : {
            afterHoursNotes: { value: 'Call the on-call line', sourceUrl: null },
            walkIns: { value: true, sourceUrl: null },
            insuranceNotes: { value: 'Accepts Delta Dental', sourceUrl: null },
          },
    );
    const report = await runDiscovery(db, categoryId, { ...discoveryDeps(), extract });
    // Far Dental also has a website, so the extractor sees both; only Near gets notes.
    expect(extract.mock.calls.map(([w]) => w).sort()).toEqual(['https://far-dental.example', 'https://near-dental.example']);
    expect(report.extracted).toBe(1);
    const near = rows().find((l) => l.placeId === 'ChIJnear')!;
    expect(near).toMatchObject({
      afterHoursNotes: 'Call the on-call line',
      walkIns: true,
      insuranceNotes: 'Accepts Delta Dental',
    });
    expect(rows().find((l) => l.placeId === 'ChIJfar')!.insuranceNotes).toBeNull();
  });

  it('skips places already stored as rejected', async () => {
    db.insert(locations)
      .values({ categoryId, placeId: 'ChIJfar', name: 'Far Dental', status: 'rejected', createdAt: now, updatedAt: now })
      .run();
    const report = await runDiscovery(db, categoryId, discoveryDeps());
    expect(report).toMatchObject({ inserted: 1, skipped: 1 });
    expect(rows().map((l) => [l.name, l.status])).toEqual([
      ['Far Dental', 'rejected'],
      ['Near Dental Group', 'candidate'],
    ]);
  });

  it('discovery refuses without home location', async () => {
    db.update(settings).set({ homeLat: null, homeLng: null }).run();
    await expect(runDiscovery(db, categoryId, discoveryDeps())).rejects.toThrow(NoHomeLocation);
    expect(rows()).toHaveLength(0);
  });

  it('stops at call cap with partial report', async () => {
    const report = await runDiscovery(db, categoryId, discoveryDeps(1));
    expect(report).toMatchObject({ searched: 1, found: 2, inserted: 0, stoppedEarly: true, callsUsed: 1 });
    expect(rows()).toHaveLength(0);
  });

  it('stops at cap after partial inserts', async () => {
    const report = await runDiscovery(db, categoryId, discoveryDeps(2));
    expect(report).toMatchObject({ inserted: 1, stoppedEarly: true, callsUsed: 2 });
    expect(rows().map((l) => l.name)).toEqual(['Near Dental Group']);
  });

  it('discovery stops when the monthly cap is reached', async () => {
    const ledger = dbLedger(db);
    ledger.add(ledger.month(now), 2, now);
    const warns: string[] = [];
    const log = { ...silent, warn: (m: unknown) => void warns.push(String(m)) };
    const budget = new CallBudget(10, { ledger, monthlyCap: 3, now: () => now });
    const d = discoveryDeps();
    const report = await runDiscovery(db, categoryId, { ...d, places: { ...d.places, budget }, log });
    expect(report).toMatchObject({ searched: 1, found: 2, inserted: 0, stoppedEarly: true, stopReason: 'month', callsUsed: 1 });
    expect(warns.join(' ')).toContain('month');
    expect(ledger.get(ledger.month(now))).toBe(3);
  });

  it('details failure falls back to the summary row', async () => {
    const gone = createCategory(db, { name: 'Gone Dentist', searchTerms: ['gone dentist'] }).id;
    const warns: string[] = [];
    const log = { ...silent, warn: (m: unknown) => void warns.push(String(m)) };
    const report = await runDiscovery(db, gone, { ...discoveryDeps(), log });
    expect(report).toMatchObject({ inserted: 2, detailsFetched: 1, stoppedEarly: false });
    const found = db.select().from(locations).where(eq(locations.categoryId, gone)).all();
    expect(found.map((l) => l.status)).toEqual(['candidate', 'candidate']);
    const g = found.find((l) => l.placeId === 'ChIJgone')!;
    expect(g).toMatchObject({ name: 'Gone Dental', phone: null, hours: null, rating: null });
    expect(found.find((l) => l.placeId === 'ChIJnear')!.phone).toBe('(801) 555-0100');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('ChIJgone');
  });

  it('cross-term duplicates are inserted once', async () => {
    const multi = createCategory(db, { name: 'Multi', searchTerms: ['emergency dentist', 'gone dentist'] }).id;
    const report = await runDiscovery(db, multi, discoveryDeps());
    expect(report).toMatchObject({ searched: 2, found: 3, inserted: 3 });
    const found = db.select().from(locations).where(eq(locations.categoryId, multi)).all();
    expect(found.filter((l) => l.name === 'Near Dental Group')).toHaveLength(1);
  });

  it('approving a candidate makes it searchable', async () => {
    await runDiscovery(db, categoryId, discoveryDeps());
    const { app } = await makeApp(false);
    const near = rows()[0]!;
    expect(await (await app.request('/search?q=near')).text()).not.toContain('Near Dental Group');
    approveLocation(db, near.id, now);
    expect(await (await app.request('/search?q=near')).text()).toContain('Near Dental Group');
  });
});

describe('discovery routes', () => {
  it('discover route 400 without places dep', async () => {
    const { app, cookie } = await makeApp(false);
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('GOOGLE_PLACES_API_KEY');
    expect(rows()).toHaveLength(0);
  });

  it('discover route 400 without home location', async () => {
    db.update(settings).set({ homeLat: null, homeLng: null }).run();
    const { app, cookie } = await makeApp(true);
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Set the home location in Settings first');
  });

  it('discover route inserts and redirects to the candidates queue', async () => {
    const { app, cookie } = await makeApp(true);
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('/admin/candidates?category=test-dentist')).toBe(true);
    expect(location).toContain('inserted=2');
    expect(rows()).toHaveLength(2);

    const html = await (await app.request(location, { headers: { cookie } })).text();
    expect(html).toContain('Near Dental Group');
    expect(html).toContain('Far Dental');
    expect(html).toContain('inserted 2');
    for (const l of rows()) {
      expect(html).toContain(`/admin/locations/${l.id}/approve`);
      expect(html).toContain(`/admin/locations/${l.id}/reject`);
    }
  });

  it('candidates queue approve returns to the queue', async () => {
    await runDiscovery(db, categoryId, discoveryDeps());
    const { app, cookie } = await makeApp(false);
    const near = rows()[0]!;
    const res = await post(
      app,
      cookie,
      `/admin/locations/${near.id}/approve`,
      new URLSearchParams({ return_to: '/admin/candidates?category=test-dentist' }).toString(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/candidates?category=test-dentist');
    expect(rows()[0]!.status).toBe('approved');
  });

  it('categories page offers a discover button', async () => {
    const { app, cookie } = await makeApp(true);
    const html = await (await app.request('/admin/categories', { headers: { cookie } })).text();
    expect(html).toContain(`/admin/categories/${categoryId}/discover`);
  });

  it('geocode route sets the home location', async () => {
    const { app, cookie } = await makeApp(true);
    const address = '200 S Main St, Salt Lake City';
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address }).toString());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/settings?saved=1');
    expect(getSettings(db)).toMatchObject({ homeLabel: address, homeLat: 40.7684, homeLng: -111.8898 });
  });

  it('geocode route 400 when address not found', async () => {
    const { app, cookie } = await makeApp(true);
    const res = await post(
      app,
      cookie,
      '/admin/settings/geocode',
      new URLSearchParams({ address: 'nowhere zzz' }).toString(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Address not found');
    expect(getSettings(db).homeLat).toBe(40.7608);
  });

  it('geocode route 400 without places dep', async () => {
    const { app, cookie } = await makeApp(false);
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'x' }).toString());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('GOOGLE_PLACES_API_KEY');
  });

  const forbiddenFetch = (async () =>
    new Response('{"error":{"message":"API key invalid"}}', { status: 403 })) as unknown as typeof fetch;
  const makeFailingApp = async () => {
    const app = createApp({ db, env: await env(), now: () => now, places: { fetch: forbiddenFetch, apiKey: 'bad' } });
    return { app, cookie: await adminLogin(app, 'correct horse') };
  };

  it('discover route returns 429 when the monthly cap is reached', async () => {
    const ledger = dbLedger(db);
    ledger.add(ledger.month(now), 800, now);
    const { app, cookie } = await makeApp(true);
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Places call cap reached (month)');
    expect(rows()).toHaveLength(0);
  });

  it('geocode route returns 429 when the monthly cap is reached', async () => {
    const ledger = dbLedger(db);
    ledger.add(ledger.month(now), 800, now);
    const { app, cookie } = await makeApp(true);
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'x' }).toString());
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Places call cap reached (month)');
  });

  it('discover route maps PlacesError to 502', async () => {
    const { app, cookie } = await makeFailingApp();
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain('Places API error 403');
    expect(html).toContain('API key invalid');
  });

  it('geocode route maps PlacesError to 502', async () => {
    const { app, cookie } = await makeFailingApp();
    const res = await post(app, cookie, '/admin/settings/geocode', new URLSearchParams({ address: 'x' }).toString());
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Places API error 403');
  });
});
