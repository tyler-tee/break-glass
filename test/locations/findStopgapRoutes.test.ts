import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { findRuns, locations, settings } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createCategory } from '../../src/features/categories/repo.js';
import { latestRun } from '../../src/features/locations/findAndRank.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

// The per-category Discover buttons now start a one-category find run; the Find places page replaces them next.
const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const now = new Date('2026-10-27T16:00:00Z');

let db: Db;
let categoryId: number;

beforeEach(() => {
  db = createTestDb();
  categoryId = createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] }).id;
});

const makeApp = async (over: Partial<AppDeps> = {}) => {
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') });
  const app = createApp({ db, env, now: () => now, places: { fetch: recordingFetch(FIXTURE_DIR, 'replay'), apiKey: 'test' }, ...over });
  return { app, cookie: await adminLogin(app, 'correct horse') };
};
const post = (app: ReturnType<typeof createApp>, cookie: string, url: string) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: '' });
const rows = () => db.select().from(locations).where(eq(locations.categoryId, categoryId)).all();

describe('categories discover route (stopgap)', () => {
  it('starts a find run for the category and redirects to the review queue', async () => {
    const { app, cookie } = await makeApp();
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/candidates?category=test-dentist');
    expect(latestRun(db)).toMatchObject({ categoryIds: [categoryId] });

    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('done'));
    expect(latestRun(db)).toMatchObject({ callsUsed: 1, llmCalls: 0 });
    expect(rows().map((r) => r.name).sort()).toEqual(['Far Dental', 'Near Dental Group']);
    expect(rows().every((r) => r.status === 'candidate' && r.rankedBy === 'rules')).toBe(true);

    const html = await (await app.request('/admin/candidates?category=test-dentist', { headers: { cookie } })).text();
    expect(html).toContain('Near Dental Group');
  });

  it('approving from the candidates queue returns to the queue', async () => {
    const { app, cookie } = await makeApp();
    await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('done'));
    const near = rows().find((r) => r.name === 'Near Dental Group')!;
    const res = await app.request(`/admin/locations/${near.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ return_to: '/admin/candidates?category=test-dentist' }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/candidates?category=test-dentist');
    expect(rows().find((r) => r.id === near.id)!.status).toBe('approved');
  });

  it('while a run is going, another press redirects without starting a second run', async () => {
    const { app, cookie } = await makeApp();
    db.insert(findRuns).values({ startedAt: now, status: 'running', categoryIds: [categoryId], progress: {} }).run();
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(302);
    expect(db.select().from(findRuns).all()).toHaveLength(1);
  });

  it('400 without a Places key', async () => {
    const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') });
    const app = createApp({ db, env, now: () => now });
    const cookie = await adminLogin(app, 'correct horse');
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Add a Google Places key in Setup → Services to enable discovery.');
    expect(latestRun(db)).toBeNull();
  });

  it('400 without a home location', async () => {
    db.update(settings).set({ homeLat: null, homeLng: null }).run();
    const { app, cookie } = await makeApp();
    const res = await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Set the home location in Settings first');
    expect(latestRun(db)).toBeNull();
  });

  it('404 for an unknown category', async () => {
    const { app, cookie } = await makeApp();
    expect((await post(app, cookie, '/admin/categories/9999/discover')).status).toBe(404);
  });

  it('places requests carry a timeout signal', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const spy = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const { app, cookie } = await makeApp({ places: { fetch: spy, apiKey: 'k' } });
    await post(app, cookie, `/admin/categories/${categoryId}/discover`);
    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('done'));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('categories page still offers the discover button', async () => {
    const { app, cookie } = await makeApp();
    const html = await (await app.request('/admin/categories', { headers: { cookie } })).text();
    expect(html).toContain(`/admin/categories/${categoryId}/discover`);
  });
});
